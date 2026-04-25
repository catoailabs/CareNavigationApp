"""Import Synthea patient resources into OpenEMR using the OpenAPI schema."""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urljoin

import httpx

from tools.forge.core import load_openapi, validate_openapi

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OPENEMR_SPEC = REPO_ROOT / "tools" / "open-api-specs" / "openEMR.yml"
PATIENT_COLLECTION_PATH = "/fhir/Patient"
OBSERVATION_COLLECTION_PATH = "/fhir/Observation"
SYNTHEA_IDENTIFIER_SYSTEM = "https://github.com/synthetichealth/synthea"


@dataclass
class OpenEMRSyntheaImportConfig:
    """Configuration for importing Synthea patients into OpenEMR."""

    openemr_base_url: str
    spec_path: Path = DEFAULT_OPENEMR_SPEC
    synthea_dir: Path | None = None
    max_patients: int | None = None
    skip_existing: bool = True
    dry_run: bool = False
    bearer_token: str | None = None
    oauth_client_id: str | None = "default"
    oauth_client_secret: str | None = None
    oauth_username: str | None = None
    oauth_password: str | None = None
    oauth_user_role: str | None = "users"
    oauth_scope: str | None = "openid offline_access api:fhir user/Patient.read user/Patient.write"
    oauth_grant_type: str = "password"
    timeout_seconds: float = 30.0
    verify_tls: bool = True


@dataclass
class ImportReport:
    """Operational summary for a Synthea import run."""

    spec_path: str
    synthea_dir: str
    patient_search_url: str
    patient_create_url: str
    token_url: str | None
    bundle_files: int = 0
    patients_seen: int = 0
    imported: int = 0
    skipped_existing: int = 0
    dry_run_would_import: int = 0
    failed: int = 0
    observations_imported: int = 0
    observations_failed: int = 0
    observations_dry_run: int = 0
    imported_ids: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        """Convert report to a JSON-serializable dictionary."""
        return {
            "spec_path": self.spec_path,
            "synthea_dir": self.synthea_dir,
            "patient_search_url": self.patient_search_url,
            "patient_create_url": self.patient_create_url,
            "token_url": self.token_url,
            "bundle_files": self.bundle_files,
            "patients_seen": self.patients_seen,
            "imported": self.imported,
            "skipped_existing": self.skipped_existing,
            "dry_run_would_import": self.dry_run_would_import,
            "failed": self.failed,
            "observations_imported": self.observations_imported,
            "observations_failed": self.observations_failed,
            "observations_dry_run": self.observations_dry_run,
            "imported_ids": self.imported_ids,
            "errors": self.errors,
        }


def load_validated_openemr_spec(spec_path: Path) -> dict[str, Any]:
    """Load and validate the OpenEMR OpenAPI schema from disk."""
    spec = load_openapi(str(spec_path))
    validation = validate_openapi(spec)
    if not validation.get("ok"):
        errors = validation.get("errors", [])
        excerpt = "; ".join(str(err.get("message", err)) for err in errors[:5]) or "unknown validation error"
        raise ValueError(f"OpenAPI schema validation failed for {spec_path}: {excerpt}")
    return spec


def resolve_operation_url(
    spec: dict[str, Any],
    openemr_base_url: str,
    *,
    path: str,
    method: str,
) -> str:
    """Resolve an operation URL from OpenAPI paths + server declaration."""
    paths = spec.get("paths", {})
    if not isinstance(paths, dict):
        raise ValueError("OpenAPI schema missing paths object")

    path_item = paths.get(path)
    if not isinstance(path_item, dict):
        raise ValueError(f"OpenAPI schema missing path: {path}")

    if method.lower() not in path_item:
        raise ValueError(f"OpenAPI schema missing {method.upper()} operation for path: {path}")

    server_base = resolve_server_base_url(spec, openemr_base_url)
    return join_url(server_base, path)


def resolve_server_base_url(spec: dict[str, Any], openemr_base_url: str) -> str:
    """Resolve the API server base URL from schema `servers` and runtime host."""
    servers = spec.get("servers", [])
    server_url = None
    if isinstance(servers, list) and servers:
        first = servers[0]
        if isinstance(first, dict):
            maybe_url = first.get("url")
            if isinstance(maybe_url, str) and maybe_url.strip():
                server_url = maybe_url.strip()
    if server_url:
        return join_url(openemr_base_url, server_url)
    return openemr_base_url.rstrip("/")


def resolve_oauth_token_url(
    spec: dict[str, Any],
    openemr_base_url: str,
    security_scheme_name: str = "openemr_auth",
) -> str:
    """Resolve the primary OAuth token URL from the OpenAPI security scheme."""
    return resolve_oauth_token_url_candidates(
        spec,
        openemr_base_url,
        security_scheme_name=security_scheme_name,
    )[0]


def resolve_oauth_token_url_candidates(
    spec: dict[str, Any],
    openemr_base_url: str,
    security_scheme_name: str = "openemr_auth",
) -> list[str]:
    """Resolve candidate OAuth token URLs from the OpenAPI security scheme."""
    components = spec.get("components", {})
    if not isinstance(components, dict):
        raise ValueError("OpenAPI schema missing components object")

    security_schemes = components.get("securitySchemes", {})
    if not isinstance(security_schemes, dict):
        raise ValueError("OpenAPI schema missing securitySchemes object")

    scheme = security_schemes.get(security_scheme_name)
    if not isinstance(scheme, dict):
        raise ValueError(f"OpenAPI schema missing security scheme: {security_scheme_name}")

    flows = scheme.get("flows", {})
    if not isinstance(flows, dict):
        raise ValueError(f"Security scheme {security_scheme_name} missing flows")

    token_url: str | None = None
    for flow_name in ("authorizationCode", "password", "clientCredentials"):
        flow = flows.get(flow_name)
        if isinstance(flow, dict):
            candidate = flow.get("tokenUrl")
            if isinstance(candidate, str) and candidate.strip():
                token_url = candidate.strip()
                break

    if not token_url:
        raise ValueError(f"Security scheme {security_scheme_name} does not define tokenUrl")

    server_base = resolve_server_base_url(spec, openemr_base_url)
    candidates = [
        join_url(server_base, token_url),
        join_url(openemr_base_url, token_url),
    ]
    return list(dict.fromkeys(candidates))


def join_url(base_url: str, path_or_url: str) -> str:
    """Join a root URL with a relative OpenAPI path/url."""
    if path_or_url.startswith(("http://", "https://")):
        return path_or_url.rstrip("/")
    return urljoin(base_url.rstrip("/") + "/", path_or_url.lstrip("/")).rstrip("/")


def resolve_synthea_fhir_dir(explicit_dir: Path | None = None) -> Path:
    """Resolve the Synthea FHIR bundle directory from explicit/env/default candidates."""
    candidates: list[Path] = []

    if explicit_dir:
        candidates.append(explicit_dir.expanduser())

    env_dir = os.getenv("SYNTHEA_FHIR_DIR")
    if env_dir:
        candidates.append(Path(env_dir).expanduser())

    data_dir = REPO_ROOT / "data"
    guidelines_dir = data_dir / "guidelines"
    candidates.extend(
        [
            guidelines_dir / "synthea" / "fhir",
            data_dir / "synthea" / "fhir",
            Path(
                "/Users/timhunter/Library/CloudStorage/"
                "GoogleDrive-tim@hi-ron.com/Shared drives/Ron/"
                "appsheet/Syntheticdata/Training Data/output/fhir"
            ),
        ]
    )

    for candidate in candidates:
        if candidate.exists() and candidate.is_dir():
            return candidate

    checked = ", ".join(str(path) for path in candidates)
    raise ValueError(
        "No Synthea FHIR directory found. Use --synthea-dir or SYNTHEA_FHIR_DIR. "
        f"Checked: {checked}"
    )


def list_synthea_bundle_files(fhir_dir: Path) -> list[Path]:
    """List Synthea bundle files from a directory."""
    return sorted(
        path
        for path in fhir_dir.glob("*.json")
        if not path.name.startswith("hospital") and not path.name.startswith("practitioner")
    )


def extract_patient_resources(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract Patient resources from a FHIR payload (Bundle or single resource)."""
    resource_type = payload.get("resourceType")
    if resource_type == "Patient":
        return [payload]

    if resource_type == "Bundle":
        patients: list[dict[str, Any]] = []
        entries = payload.get("entry", [])
        if not isinstance(entries, list):
            return patients
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            resource = entry.get("resource")
            if isinstance(resource, dict) and resource.get("resourceType") == "Patient":
                patients.append(resource)
        return patients

    return []


def extract_observation_resources(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """Extract Observation resources from a FHIR Bundle."""
    if not isinstance(payload, dict) or payload.get("resourceType") != "Bundle":
        return []
    observations: list[dict[str, Any]] = []
    for entry in payload.get("entry", []):
        if not isinstance(entry, dict):
            continue
        resource = entry.get("resource")
        if isinstance(resource, dict) and resource.get("resourceType") == "Observation":
            observations.append(resource)
    return observations


def normalize_observation_for_create(
    observation: dict[str, Any],
    new_patient_id: str,
) -> dict[str, Any]:
    """Normalize an Observation for POST, rewriting the subject reference."""
    normalized = json.loads(json.dumps(observation))
    normalized.pop("id", None)
    meta = normalized.get("meta")
    if isinstance(meta, dict):
        meta.pop("versionId", None)
        meta.pop("lastUpdated", None)
        if not meta:
            normalized.pop("meta", None)
    # Rewrite subject reference to the newly created Patient
    normalized["subject"] = {"reference": f"Patient/{new_patient_id}"}
    # Rewrite encounter reference if present (drop it — the encounter may not exist yet)
    normalized.pop("encounter", None)
    return normalized


def build_identifier_queries(patient: dict[str, Any]) -> list[str]:
    """Build FHIR identifier query values from a Patient resource."""
    raw_identifiers = patient.get("identifier", [])
    if not isinstance(raw_identifiers, list):
        return []

    queries: list[str] = []
    for identifier in raw_identifiers:
        if not isinstance(identifier, dict):
            continue
        value = str(identifier.get("value", "")).strip()
        if not value:
            continue
        system = str(identifier.get("system", "")).strip()
        if system:
            queries.append(f"{system}|{value}")
        queries.append(value)

    return list(dict.fromkeys(queries))


def find_synthea_identifier_query(patient: dict[str, Any]) -> str | None:
    """Return the canonical Synthea identifier query when present."""
    raw_identifiers = patient.get("identifier", [])
    if not isinstance(raw_identifiers, list):
        return None

    for identifier in raw_identifiers:
        if not isinstance(identifier, dict):
            continue
        system = str(identifier.get("system", "")).strip()
        value = str(identifier.get("value", "")).strip()
        if system == SYNTHEA_IDENTIFIER_SYSTEM and value:
            return f"{system}|{value}"

    return None


def normalize_patient_for_create(patient: dict[str, Any]) -> dict[str, Any]:
    """Normalize a Patient payload for POST /fhir/Patient create semantics."""
    normalized = json.loads(json.dumps(patient))
    normalized.pop("id", None)
    meta = normalized.get("meta")
    if isinstance(meta, dict):
        meta.pop("versionId", None)
        meta.pop("lastUpdated", None)
        if not meta:
            normalized.pop("meta", None)
    return normalized


def obtain_oauth_access_token(
    client: httpx.Client,
    token_url: str,
    *,
    grant_type: str,
    client_id: str | None,
    client_secret: str | None,
    username: str | None,
    password: str | None,
    user_role: str | None,
    scope: str | None,
) -> str:
    """Exchange credentials for an OAuth access token."""
    form_data: dict[str, str] = {"grant_type": grant_type}
    if client_id:
        form_data["client_id"] = client_id
    if client_secret:
        form_data["client_secret"] = client_secret
    if username:
        form_data["username"] = username
    if password:
        form_data["password"] = password
    if user_role:
        form_data["user_role"] = user_role
    if scope:
        form_data["scope"] = scope

    headers = {"Accept": "application/json"}
    response = client.post(token_url, data=form_data, headers=headers)

    # Retry with HTTP basic client auth if token endpoint rejects body client credentials.
    if (
        response.status_code in (400, 401)
        and client_id
        and client_secret
        and "access_token" not in response.text
    ):
        retried_form = dict(form_data)
        retried_form.pop("client_secret", None)
        response = client.post(
            token_url,
            data=retried_form,
            headers=headers,
            auth=(client_id, client_secret),
        )

    if response.is_error:
        detail = response.text[:500]
        raise ValueError(
            f"OAuth token request failed ({response.status_code}) at {token_url}: {detail}"
        )

    payload = response.json()
    token = payload.get("access_token") or payload.get("token")
    if not isinstance(token, str) or not token.strip():
        raise ValueError(
            f"OAuth token response missing access_token at {token_url}: {json.dumps(payload)[:500]}"
        )
    return token.strip()


def _build_demographic_query(patient: dict[str, Any]) -> dict[str, str]:
    """Build a fallback demographic query for duplicate detection."""
    query: dict[str, str] = {}

    names = patient.get("name", [])
    if isinstance(names, list) and names:
        primary = names[0]
        if isinstance(primary, dict):
            family = primary.get("family")
            if isinstance(family, str) and family.strip():
                query["family"] = family.strip()

            given = primary.get("given")
            if isinstance(given, list) and given:
                first_given = given[0]
                if isinstance(first_given, str) and first_given.strip():
                    query["given"] = first_given.strip()

    birth_date = patient.get("birthDate")
    if isinstance(birth_date, str) and birth_date.strip():
        query["birthdate"] = birth_date.strip()

    return query


def _contains_existing_patient(bundle: Any) -> bool:
    """Return True when a FHIR bundle includes at least one entry."""
    if not isinstance(bundle, dict):
        return False

    total = bundle.get("total")
    if isinstance(total, int) and total > 0:
        return True

    entries = bundle.get("entry")
    return isinstance(entries, list) and len(entries) > 0


def _extract_first_bundle_patient_id(bundle: Any) -> str | None:
    """Extract first Patient ID from a FHIR search bundle if present."""
    if not isinstance(bundle, dict):
        return None

    entries = bundle.get("entry")
    if not isinstance(entries, list) or not entries:
        return None

    first = entries[0]
    if not isinstance(first, dict):
        return None
    resource = first.get("resource")
    if not isinstance(resource, dict):
        return None
    resource_id = resource.get("id")
    if isinstance(resource_id, str) and resource_id.strip():
        return resource_id.strip()
    return None


def _search_existing_patient(
    client: httpx.Client,
    patient_search_url: str,
    headers: dict[str, str],
    patient: dict[str, Any],
) -> tuple[bool, str | None]:
    """Search OpenEMR for an existing patient using identifiers/demographics."""
    synthea_identifier = find_synthea_identifier_query(patient)
    if synthea_identifier:
        response = client.get(
            patient_search_url,
            headers=headers,
            params={"identifier": synthea_identifier},
        )
        if response.status_code == 401:
            raise ValueError(
                "OpenEMR rejected patient search with 401 Unauthorized. "
                "Check bearer token or OAuth client scope."
            )
        if response.status_code >= 500:
            raise ValueError(
                f"OpenEMR patient search failed with {response.status_code}: {response.text[:300]}"
            )
        if response.status_code < 400:
            try:
                payload = response.json()
            except Exception:
                payload = {}
            if _contains_existing_patient(payload):
                return True, _extract_first_bundle_patient_id(payload)
        return False, None

    query_candidates: list[dict[str, str]] = []
    query_candidates.extend({"identifier": value} for value in build_identifier_queries(patient))

    demographic_query = _build_demographic_query(patient)
    if demographic_query:
        query_candidates.append(demographic_query)

    for query in query_candidates:
        response = client.get(patient_search_url, headers=headers, params=query)
        if response.status_code == 401:
            raise ValueError(
                "OpenEMR rejected patient search with 401 Unauthorized. "
                "Check bearer token or OAuth client scope."
            )
        if response.status_code >= 500:
            raise ValueError(
                f"OpenEMR patient search failed with {response.status_code}: {response.text[:300]}"
            )
        if response.status_code >= 400:
            # Some servers reject system|value identifier form. Try next query candidate.
            continue

        payload: Any
        try:
            payload = response.json()
        except Exception:
            payload = {}
        if _contains_existing_patient(payload):
            return True, _extract_first_bundle_patient_id(payload)

    return False, None


def _extract_created_patient_id(create_response: httpx.Response) -> str | None:
    """Extract newly created patient identifier from response JSON."""
    try:
        payload = create_response.json()
    except Exception:
        return None

    if not isinstance(payload, dict):
        return None

    resource_id = payload.get("id")
    if isinstance(resource_id, str) and resource_id.strip():
        return resource_id.strip()

    return None


def _import_observations_for_patient(
    client: httpx.Client,
    headers: dict[str, str],
    observations: list[dict[str, Any]],
    patient_id: str,
    original_patient: dict[str, Any],
    openemr_base_url: str,
    spec: dict[str, Any],
    report: ImportReport,
    dry_run: bool,
    bundle_path: Path,
) -> None:
    """Import Observation resources for a newly created patient."""
    if not observations:
        return

    # Match observations to this patient by checking the subject reference
    original_patient_id = original_patient.get("id", "")
    patient_observations = [
        obs for obs in observations
        if _observation_references_patient(obs, original_patient_id)
    ]

    if not patient_observations:
        return

    if dry_run:
        report.observations_dry_run += len(patient_observations)
        return

    # OpenEMR's FHIR API has no POST for /fhir/Observation (spec only documents GET).
    # The standard API supports POST /api/patient/{pid}/encounter/{eid}/vital for
    # vitals only (bps, bpd, weight, height, temp, pulse, respiration, O2 sat).
    # We need an encounter first, then can post vitals. For lab Observations,
    # there is no write endpoint in the OpenEMR OpenAPI spec.
    #
    # Strategy: create an encounter via POST /api/patient/{puuid}/encounter,
    # then post vital-sign Observations via POST /api/patient/{pid}/encounter/{eid}/vital.
    # Lab Observations are logged as skipped — they require direct DB access or a
    # future OpenEMR API version that supports Observation writes.

    server_base = resolve_server_base_url(spec, openemr_base_url)
    encounter_url = join_url(server_base, f"/api/patient/{patient_id}/encounter")

    # Create a single import encounter for this patient's observations
    encounter_payload = {
        "date": "2024-01-01",
        "onset_date": "",
        "reason": "Synthea data import",
        "facility": "Default",
        "pc_catid": "5",  # Office Visit
        "class_code": "AMB",
    }

    encounter_id: str | None = None
    try:
        enc_response = client.post(encounter_url, headers=headers, json=encounter_payload)
        if enc_response.status_code in (200, 201):
            enc_data = enc_response.json()
            encounter_id = str(enc_data.get("uuid") or enc_data.get("id", "")).strip() or None
    except Exception as exc:
        logger.warning("Could not create encounter for patient %s: %s", patient_id, exc)

    if not encounter_id:
        report.observations_failed += len(patient_observations)
        return

    vital_url = join_url(server_base, f"/api/patient/{patient_id}/encounter/{encounter_id}/vital")

    # Map LOINC codes to OpenEMR vital fields
    LOINC_TO_VITAL_FIELD = {
        "8480-6": "bps",       # Systolic blood pressure
        "8462-4": "bpd",       # Diastolic blood pressure
        "29463-7": "weight",   # Body weight
        "8302-2": "height",    # Body height
        "8310-5": "temperature",  # Body temperature
        "8867-4": "pulse",     # Heart rate
        "9279-1": "respiration",  # Respiratory rate
        "2708-6": "oxygen_saturation",  # Oxygen saturation
        "59408-5": "oxygen_saturation",  # SpO2 by pulse oximetry
        "8287-5": "head_circ", # Head circumference
    }

    vitals_payload: dict[str, str] = {}
    labs_skipped = 0

    for obs in patient_observations:
        codings = obs.get("code", {}).get("coding", [])
        loinc_code = ""
        for coding in codings:
            if isinstance(coding, dict) and "loinc" in coding.get("system", "").lower():
                loinc_code = coding.get("code", "")
                break

        vital_field = LOINC_TO_VITAL_FIELD.get(loinc_code)
        if vital_field:
            value = obs.get("valueQuantity", {}).get("value")
            if value is not None:
                vitals_payload[vital_field] = str(value)
        else:
            labs_skipped += 1

    if vitals_payload:
        try:
            response = client.post(vital_url, headers=headers, json=vitals_payload)
            if response.status_code in (200, 201):
                report.observations_imported += len(vitals_payload)
            else:
                report.observations_failed += len(vitals_payload)
                if report.observations_failed <= 5:
                    report.errors.append(
                        f"{bundle_path}: vital POST failed ({response.status_code})"
                    )
        except Exception as exc:
            report.observations_failed += len(vitals_payload)
            if report.observations_failed <= 5:
                report.errors.append(f"{bundle_path}: vital POST error ({exc})")

    if labs_skipped:
        logger.debug(
            "Skipped %d lab Observations for patient %s (no write endpoint in OpenEMR spec)",
            labs_skipped, patient_id,
        )


def _observation_references_patient(obs: dict[str, Any], patient_id: str) -> bool:
    """Check if an Observation's subject references the given patient ID."""
    subject = obs.get("subject", {})
    if not isinstance(subject, dict):
        return False
    ref = subject.get("reference", "")
    return isinstance(ref, str) and (
        ref == f"Patient/{patient_id}"
        or ref.endswith(f"/{patient_id}")
        or f"urn:uuid:{patient_id}" in ref
    )


def import_synthea_patients(config: OpenEMRSyntheaImportConfig) -> dict[str, Any]:
    """Import Synthea Patient resources into OpenEMR and return an execution report."""
    spec = load_validated_openemr_spec(config.spec_path)

    patient_search_url = resolve_operation_url(
        spec,
        config.openemr_base_url,
        path=PATIENT_COLLECTION_PATH,
        method="get",
    )
    patient_create_url = resolve_operation_url(
        spec,
        config.openemr_base_url,
        path=PATIENT_COLLECTION_PATH,
        method="post",
    )

    synthea_dir = resolve_synthea_fhir_dir(config.synthea_dir)
    bundle_paths = list_synthea_bundle_files(synthea_dir)
    if not bundle_paths:
        raise ValueError(f"No Synthea JSON bundles found under {synthea_dir}")

    report = ImportReport(
        spec_path=str(config.spec_path),
        synthea_dir=str(synthea_dir),
        patient_search_url=patient_search_url,
        patient_create_url=patient_create_url,
        token_url=None,
        bundle_files=len(bundle_paths),
    )

    with httpx.Client(
        timeout=config.timeout_seconds,
        verify=config.verify_tls,
        follow_redirects=True,
    ) as client:
        bearer_token = config.bearer_token
        if not bearer_token:
            if not config.oauth_username or not config.oauth_password:
                raise ValueError(
                    "Missing OAuth credentials. Provide --bearer-token or set "
                    "--oauth-username/--oauth-password (or OPENEMR_API_USER/OPENEMR_API_PASSWORD)."
                )
            token_errors: list[str] = []
            token_candidates = resolve_oauth_token_url_candidates(spec, config.openemr_base_url)
            for token_candidate in token_candidates:
                report.token_url = token_candidate
                try:
                    bearer_token = obtain_oauth_access_token(
                        client,
                        token_candidate,
                        grant_type=config.oauth_grant_type,
                        client_id=config.oauth_client_id,
                        client_secret=config.oauth_client_secret,
                        username=config.oauth_username,
                        password=config.oauth_password,
                        user_role=config.oauth_user_role,
                        scope=config.oauth_scope,
                    )
                    break
                except ValueError as exc:
                    token_errors.append(str(exc))

            if not bearer_token:
                raise ValueError(
                    "OAuth token request failed for all schema-derived token URLs: "
                    + "; ".join(token_errors)
                )

        headers = {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "Authorization": f"Bearer {bearer_token}",
        }

        stop_import = False
        for bundle_path in bundle_paths:
            if stop_import:
                break

            try:
                bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
            except Exception as exc:
                report.failed += 1
                report.errors.append(f"{bundle_path}: failed to read/parse JSON ({exc})")
                continue

            patients = extract_patient_resources(bundle)
            observations = extract_observation_resources(bundle)
            report.patients_seen += len(patients)

            for patient in patients:
                if config.max_patients is not None and (
                    report.imported + report.dry_run_would_import
                ) >= config.max_patients:
                    stop_import = True
                    break

                normalized_patient = normalize_patient_for_create(patient)

                try:
                    if config.skip_existing:
                        exists, _ = _search_existing_patient(
                            client,
                            patient_search_url,
                            headers,
                            normalized_patient,
                        )
                        if exists:
                            report.skipped_existing += 1
                            continue
                except Exception as exc:
                    report.failed += 1
                    report.errors.append(f"{bundle_path}: duplicate check failed ({exc})")
                    continue

                if config.dry_run:
                    report.dry_run_would_import += 1
                    report.observations_dry_run += len(observations)
                    continue

                response = client.post(
                    patient_create_url,
                    headers=headers,
                    json=normalized_patient,
                )
                if response.status_code in (200, 201):
                    report.imported += 1
                    created_id = _extract_created_patient_id(response)
                    if created_id:
                        report.imported_ids.append(created_id)
                        # Import Observations for this patient
                        _import_observations_for_patient(
                            client=client,
                            headers=headers,
                            observations=observations,
                            patient_id=created_id,
                            original_patient=patient,
                            openemr_base_url=config.openemr_base_url,
                            spec=spec,
                            report=report,
                            dry_run=config.dry_run,
                            bundle_path=bundle_path,
                        )
                    continue

                if response.status_code == 409:
                    report.skipped_existing += 1
                    continue

                report.failed += 1
                report.errors.append(
                    f"{bundle_path}: create failed ({response.status_code}) {response.text[:300]}"
                )

    logger.info(
        "Synthea import complete: patients_imported=%s observations_imported=%s "
        "skipped_existing=%s failed=%s obs_failed=%s dry_run_patients=%s dry_run_obs=%s",
        report.imported,
        report.observations_imported,
        report.skipped_existing,
        report.failed,
        report.observations_failed,
        report.dry_run_would_import,
        report.observations_dry_run,
    )
    return report.to_dict()


__all__ = [
    "OpenEMRSyntheaImportConfig",
    "build_identifier_queries",
    "extract_patient_resources",
    "find_synthea_identifier_query",
    "import_synthea_patients",
    "join_url",
    "load_validated_openemr_spec",
    "resolve_oauth_token_url",
    "resolve_oauth_token_url_candidates",
    "resolve_operation_url",
    "resolve_server_base_url",
    "resolve_synthea_fhir_dir",
]

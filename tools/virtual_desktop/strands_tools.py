import subprocess
import json
import os
from strands import tool


@tool
def start_virtual_desktop_environment() -> str:
    """Start the virtual desktop environment (including OpenEMR and Orthanc) using docker compose. This will start the ron-agent-desktop container."""
    compose_dir = os.path.dirname(__file__)
    try:
        subprocess.run(
            ["docker", "compose", "up", "-d"],
            cwd=compose_dir,
            check=True,
            capture_output=True,
            text=True,
        )

        # We can kick off the synthea load in the background, or inform the agent
        return "Virtual desktop environment started successfully on port 3001. OpenEMR is booting up and data is permanently persisted in Docker volumes. Use load_synthea_patients() if the database is fresh."
    except subprocess.CalledProcessError as e:
        return f"Failed to start environment: {e.stderr}"


@tool
def stop_virtual_desktop_environment() -> str:
    """Stop the virtual desktop environment."""
    compose_dir = os.path.dirname(__file__)
    try:
        subprocess.run(
            ["docker", "compose", "down"],
            cwd=compose_dir,
            check=True,
            capture_output=True,
            text=True,
        )
        return "Virtual desktop environment stopped successfully."
    except subprocess.CalledProcessError as e:
        return f"Failed to stop environment: {e.stderr}"


@tool
def load_synthea_patients() -> str:
    """Load the pre-packaged Synthea patients into the OpenEMR instance running in the virtual desktop environment."""
    from .openemr_synthea_import import (
        import_synthea_patients,
        OpenEMRSyntheaImportConfig,
    )

    current_dir = os.path.dirname(os.path.abspath(__file__))
    synthea_dir = os.path.join(current_dir, "synthea", "fhir")

    # We load from the original open-api-specs path (assuming it exists in the main tools repo)
    spec_path = os.path.join(
        os.path.dirname(current_dir), "open-api-specs", "openEMR.yml"
    )

    if not os.path.exists(synthea_dir):
        return f"Error: Synthea directory not found at {synthea_dir}"

    config = OpenEMRSyntheaImportConfig(
        openemr_base_url="http://localhost:80",
        synthea_dir=synthea_dir,
        spec_path=spec_path,
        oauth_username="admin",
        oauth_password="changeme_in_production",
    )
    try:
        report = import_synthea_patients(config)
        return f"Synthea patients loaded successfully: {json.dumps(report, indent=2)}"
    except Exception as e:
        return f"Failed to load Synthea patients: {str(e)}"


VIRTUAL_DESKTOP_TOOLS = [
    start_virtual_desktop_environment,
    stop_virtual_desktop_environment,
    load_synthea_patients,
]

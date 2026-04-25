-- Initialize databases for Orthanc and OpenEMR
-- Orthanc DB is created by POSTGRES_DB env var; this adds OpenEMR's

CREATE DATABASE openemr;
GRANT ALL PRIVILEGES ON DATABASE openemr TO ron;
GRANT ALL PRIVILEGES ON DATABASE orthanc TO ron;

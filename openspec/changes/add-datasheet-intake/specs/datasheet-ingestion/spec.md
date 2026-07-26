# Delta Spec: datasheet-ingestion

## ADDED Requirements

### Requirement: Datasheet ingestion via Sarvam Extract and Digitise
The system SHALL send a datasheet to Sarvam Extract (with a described field list) and Sarvam Digitise (for structured text with bounding boxes) and assemble the results into `ExtractedFact[]`, using the async job lifecycle: create job, upload file, start, poll status, download results.

#### Scenario: Fields extracted with confidence (AC-1.1)
- **WHEN** ingestion runs on a real datasheet page with a field list
- **THEN** at least 4 fields return with a numeric or string value and a `confidence` in [0, 1]

#### Scenario: Bounding boxes populated (AC-1.2)
- **WHEN** a fact is assembled from a completed Digitise result
- **THEN** its `source.page` is set, and for at least the leakage fact `source.bbox` is populated

#### Scenario: Page limit respected
- **WHEN** a datasheet is submitted for ingestion
- **THEN** only the relevant pages (at most 2) are sent, staying under Sarvam's 10-page limit

### Requirement: Poll timeout with typed failure
The system SHALL wrap job polling in a timeout (`POLL_TIMEOUT_MS = 90000`, poll interval 2 s) and SHALL surface expiry as a typed timeout error rather than hanging.

#### Scenario: Polling exceeds the timeout (AC-1.3)
- **WHEN** a Sarvam job does not complete within `POLL_TIMEOUT_MS`
- **THEN** the system throws a typed timeout error, falls back to fixtures if `USE_FIXTURES=true`, and never hangs the UI

### Requirement: Backoff on rate limiting
The system SHALL retry Sarvam calls that fail with 429 or 503 using exponential backoff (base 1 s, factor 2) up to 3 retries before failing.

#### Scenario: 429 from Sarvam (AC-12.1)
- **WHEN** a Sarvam call returns 429
- **THEN** the client retries with exponential backoff up to 3 times before surfacing the failure

### Requirement: Fixtures fallback
The system SHALL support `USE_FIXTURES=true`, serving pre-generated cached Extract and Digitise JSON through the same provider interface with no network calls. Cached fixtures for each demo datasheet are a required deliverable.

#### Scenario: Fixture mode makes no network calls (AC-12.2)
- **WHEN** ingestion runs with `USE_FIXTURES=true`
- **THEN** cached Extract and Digitise JSON is used and no network call is made

### Requirement: Content-hash extraction cache
The system SHALL cache Extract and Digitise results keyed by the datasheet content hash (and field-list hash for Extract) and SHALL consult the cache before creating any Sarvam job.

#### Scenario: Repeat ingestion of the same document
- **WHEN** a datasheet whose content hash already has cached results is ingested again
- **THEN** the cached results are returned and no Sarvam job is created

# run-observability — Delta Spec

## ADDED Requirements

### Requirement: Assistant turns stream to the terminal
A provider that supports streaming SHALL deliver assistant text as it is generated, and the loop SHALL print it while the turn is still running rather than when it ends. A turn SHALL appear exactly once regardless of which path produced it.

#### Scenario: Text appears during the turn
- **WHEN** a provider streams a turn's text
- **THEN** the text is printed as it arrives, line by line, and the completed turn is not printed again

#### Scenario: A non-streaming provider is unchanged
- **WHEN** a provider returns a turn in one piece
- **THEN** its text is printed once, at the end of the turn, exactly as before

#### Scenario: An interrupted turn keeps what arrived
- **WHEN** a streamed turn times out or errors mid-generation
- **THEN** the text received so far has been printed, including any trailing partial line

#### Scenario: Token accounting is identical on both paths
- **WHEN** the same turn is served streamed and non-streamed
- **THEN** the reported input and output token counts are the same, and the run's budget and cost table are unaffected by which path ran

#### Scenario: An endpoint that refuses to stream
- **WHEN** an endpoint rejects a streamed request (an OpenAI-compatible implementation without `stream_options`, an org not permitted to stream)
- **THEN** that turn is retried once without streaming, the refusal is recorded in `raw.log`, the run continues normally, and the endpoint is not asked to stream again for the rest of the session

### Requirement: Every run records its provider traffic verbatim
The agent loop SHALL write `raw.log` in the run directory, live, one JSON object per entry, containing what each provider was sent and what it returned: request and response payloads for the API providers, and the provider's own messages for the CLI-backed ones. Each entry SHALL name the provider that produced it.

#### Scenario: Request and response are both recorded
- **WHEN** a turn completes
- **THEN** `raw.log` contains that turn's request payload and its response payload, attributed to the provider that served it

#### Scenario: Written as the run happens
- **WHEN** a run is still in progress
- **THEN** the entries for completed turns are already on disk, not buffered until the run ends

#### Scenario: A payload that cannot be serialized
- **WHEN** a provider returns a payload that cannot be converted to JSON
- **THEN** an entry is still written, marked as unserializable, and the turn proceeds

#### Scenario: Bounded size
- **WHEN** a single payload, or the log as a whole, exceeds its cap
- **THEN** the entry is truncated (or further entries are dropped) with a marker saying so, rather than growing without limit or failing the run

#### Scenario: Secrets never land in it
- **WHEN** a payload contains a string matching the API-key pattern
- **THEN** the written entry has it redacted (AC-4.1)

### Requirement: Every run mirrors its console output
The agent loop SHALL write `console.log` in the run directory, live, containing every durable line the run printed, with ANSI escapes removed.

#### Scenario: What the operator saw is recoverable
- **WHEN** a run ends
- **THEN** `console.log` contains its turn markers, assistant text, tool result lines, heartbeats, and final outcome line, in order

#### Scenario: Transient chrome is not mirrored
- **WHEN** the interactive renderer redraws its pinned status line
- **THEN** those redraws do not appear in `console.log`

#### Scenario: Plain text
- **WHEN** a run prints colored output
- **THEN** the mirrored lines contain no ANSI escape sequences

#### Scenario: Secrets never land in the mirror either
- **WHEN** a printed line contains a string matching the API-key pattern
- **THEN** the mirrored line has it redacted (AC-4.1)

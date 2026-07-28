export const metadata = { title: "copperhead intake · help" };

export default function Help() {
  return (
    <main className="help">
      <h1>
        copperhead <span className="accent">intake</span> · help
      </h1>
      <p className="lead">
        Point it at a component datasheet plus a proposed board change. It extracts typed,
        source-cited, confidence-scored facts and answers APPROVE, REFUSE, or HOLD, citing the exact
        datasheet line and the exact board rule. A wrong fact is worse than a missing one, so
        anything uncertain is held, never trusted.
      </p>

      <h2>What happens under the hood</h2>
      <ol>
        <li>
          <strong>Digitise (Sarvam Vision).</strong> The PDF pages become structured text with a
          bounding box for every block: that is what makes click-to-source possible.
        </li>
        <li>
          <strong>Extract (Claude).</strong> Claude reads the digitised text and reports each
          requested field with the value as printed, the page, a verbatim snippet, and its own
          confidence. It runs through your Claude Code login or an API key.
        </li>
        <li>
          <strong>Verify and gate (deterministic).</strong> The pipeline checks each snippet
          literally occurs in the digitised text (a hallucinated value can never be trusted),
          locates it to assign the bounding box, normalizes units (0.033 mA becomes 33 uA), and
          applies the 0.75 confidence gate. Anything short of fully verified is amber: held for
          review.
        </li>
        <li>
          <strong>Judge (pure function).</strong> The verdict engine compares the change against the
          board rulebook (<code>constraints.json</code>: budgets, abs-max rails). No network, no
          model, no clock: identical inputs always give the identical verdict, and every exported
          manifest can be replayed to reproduce it.
        </li>
      </ol>

      <h2>How to run the demo</h2>
      <ol>
        <li>
          Pick a part in step 1 (LM555, SN74LS00, or ESP32-WROOM-32). The console narrates each
          pipeline stage. In <strong>cached</strong> mode everything serves from committed fixtures:
          instant and fully offline. In <strong>live</strong> mode the real Sarvam and Claude calls
          run (roughly 45 seconds).
        </li>
        <li>
          Review the facts in step 2. Click any fact and the datasheet on the right scrolls to the
          exact line it came from. Amber facts show why they are held; hit
          <em> Confirm / correct</em> to verify the value yourself: a user-verified fact becomes
          trusted and can decide.
        </li>
        <li>
          Propose a change in step 3: the three presets cover the classic failure stories (a pull-up
          that busts the sleep budget, 5 V into a 3.6 V pin, a part too thirsty to stay powered).
          Custom changes work too.
        </li>
        <li>
          Read the verdict in step 4. A REFUSE names the measured value, the limit, and the
          deviation, cites both the datasheet line (click it) and the board rule, and proposes a
          fix. Export the manifest for the audit trail.
        </li>
      </ol>

      <h2>Things worth showing off</h2>
      <ul>
        <li>
          <strong>HOLD dominance:</strong> evaluate a change whose deciding fact is amber: the judge
          refuses to decide and names the field to re-check.
        </li>
        <li>
          <strong>Correction propagation:</strong> correct an amber fact and the verdict recomputes
          instantly, with no re-extraction.
        </li>
        <li>
          <strong>Fail closed:</strong> break <code>data/constraints.json</code> on purpose: the
          engine refuses to evaluate rather than approving by default.
        </li>
        <li>
          <strong>Memory:</strong> refresh the page: facts persist in the registry, and a second
          change on the same part never re-reads the datasheet.
        </li>
      </ul>

      <p>
        <a href="/">back to the demo</a>
      </p>
    </main>
  );
}

import { SidePanel } from "../components/SidePanel.tsx";
import { AreaTag } from "./AreaTag.tsx";
import type { ScenarioRow } from "./model.ts";

const asText = (value: unknown) => (typeof value === "string" ? value : JSON.stringify(value, null, 2));

/** One drafted scenario: the conversation, the situation, what each tool answers, and what should happen. */
export function ScenarioPanel({
  row,
  testsDir,
  position,
  onPrev,
  onNext,
  onClose,
  onAdd,
}: {
  row: ScenarioRow;
  testsDir: string;
  position: string;
  onPrev?: () => void;
  onNext?: () => void;
  onClose: () => void;
  /** Absent when the draft is already in the suite, invalid, or being added. */
  onAdd?: () => void;
}) {
  const t = row.test;
  const context = Object.entries(t.context ?? {});
  const tools = Object.entries(t.tool_responses ?? {});
  const checks = Object.entries(t.checks ?? {});
  return (
    <SidePanel
      id={row.file}
      badge={<AreaTag area={row.item.area} />}
      title={t.name}
      subtitle={`Covers: ${row.item.title}`}
      position={position}
      noun="scenario"
      onPrev={onPrev}
      onNext={onNext}
      onClose={onClose}
      footer={
        row.savedFile ? (
          <span className="status-pill complete">
            in tests as {testsDir}/{row.savedFile}
          </span>
        ) : row.issue ? (
          <span className="job-error">Can't add: {row.issue}</span>
        ) : (
          <button className="dashboard-button primary" disabled={!onAdd} onClick={onAdd}>
            Add to tests
          </button>
        )
      }
    >
      <section>
        <h3>Conversation</h3>
        <ol className="thread">
          {(t.conversation ?? []).map((turn, i) => (
            <li key={i} className={turn.role}>
              <span>{turn.role === "user" ? "User" : "Agent"}</span>
              <p>{turn.content}</p>
            </li>
          ))}
          <li className="user next">
            <span>User · next message</span>
            <p>{t.input}</p>
          </li>
        </ol>
      </section>
      {!!context.length && (
        <section>
          <h3>Situation</h3>
          <dl className="kv">
            {context.map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>
                  <pre>{asText(value)}</pre>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {!!tools.length && (
        <section>
          <div className="panel-sec-head">
            <h3>Tool answers</h3>
            <span>what each tool answers in this scenario</span>
          </div>
          <div className="tool-answers">
            {tools.map(([tool, outputs]) => (
              <div key={tool}>
                <code>{tool}</code>
                {outputs.map((output, i) => (
                  <div key={i} className="tool-answer">
                    <span>
                      {outputs.length === 1
                        ? "every call"
                        : i === outputs.length - 1
                          ? `call ${i + 1} on`
                          : `call ${i + 1}`}
                    </span>
                    <pre>{asText(output)}</pre>
                  </div>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
      <section>
        <h3>What should happen</h3>
        <dl className="kv">
          {!!t.must_call_tools?.length && (
            <div>
              <dt>must call</dt>
              <dd className="chips">
                {t.must_call_tools.map((tool) => (
                  <code key={tool}>{tool}</code>
                ))}
              </dd>
            </div>
          )}
          {!!t.must_not_call_tools?.length && (
            <div>
              <dt>must never call</dt>
              <dd className="chips forbidden">
                {t.must_not_call_tools.map((tool) => (
                  <code key={tool}>{tool}</code>
                ))}
              </dd>
            </div>
          )}
          {t.grading_criteria && (
            <div>
              <dt>graded on</dt>
              <dd>{t.grading_criteria}</dd>
            </div>
          )}
          {checks.map(([id, question]) => (
            <div key={id}>
              <dt>check · {id}</dt>
              <dd>{typeof question === "string" ? question : question.question}</dd>
            </div>
          ))}
        </dl>
      </section>
    </SidePanel>
  );
}

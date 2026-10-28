/**
 * Reading takes about a second, but the photo chunking is the slow part, so
 * the progress bar is real rather than decorative. Steps light up in the
 * order the card is actually traversed.
 */
import { For } from "solid-js";
import { PROGRESS_STEPS, progressIndex } from "../format.ts";
import type { Progress } from "../ws.ts";

function stepState(index: number, current: number): "done" | "current" | "pending" {
  if (index < current) return "done";
  if (index === current) return "current";
  return "pending";
}

function stepSuffix(state: "done" | "current" | "pending"): string {
  switch (state) {
    case "done":
      return "เสร็จแล้ว";
    case "current":
      return "กำลังดำเนินการ";
    default:
      return "รอดำเนินการ";
  }
}

export function Timeline(props: { progress: Progress | null }) {
  const index = (): number => progressIndex(props.progress?.step ?? null);

  const pct = (): number => {
    const value = props.progress?.pct ?? 0;
    return Math.round(Math.min(100, Math.max(0, value)));
  };

  const currentLabel = (): string => {
    const at = index();
    return at >= 0 ? PROGRESS_STEPS[at]!.label : "กำลังเริ่มอ่านบัตร…";
  };

  return (
    <section class="panel reading" aria-labelledby="reading-title">
      <div class="reading__head">
        <div>
          <p class="eyebrow">กำลังอ่านข้อมูล</p>
          <h2 id="reading-title">{currentLabel()}</h2>
          <p class="reading__hint" role="status">
            กรุณาอย่าถอดบัตรจนกว่าจะเสร็จ
          </p>
        </div>
        <p class="reading__pct" aria-hidden="true">
          {props.progress === null ? "—" : `${pct()}%`}
        </p>
      </div>

      <progress class="progress" max="100" value={pct()} aria-label="ความคืบหน้าการอ่านบัตร" />

      <ol class="steps">
        <For each={PROGRESS_STEPS}>
          {(step, i) => {
            const state = (): "done" | "current" | "pending" => stepState(i(), index());

            return (
              <li
                class="step"
                data-state={state()}
                aria-current={state() === "current" ? "step" : undefined}
              >
                <span class="step__marker" aria-hidden="true">
                  {state() === "done" ? "✓" : state() === "pending" ? i() + 1 : ""}
                </span>
                <span class="step__label">{step.label}</span>
                <span class="visually-hidden"> — {stepSuffix(state())}</span>
              </li>
            );
          }}
        </For>
      </ol>
    </section>
  );
}

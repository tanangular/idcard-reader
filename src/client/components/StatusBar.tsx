/**
 * The one-line answer to "what is happening right now?". It is driven by the
 * server's state machine plus the browser's socket state; no local guessing.
 */
import { Show } from "solid-js";
import type { AppError, ReaderState } from "../../shared/protocol.ts";
import { PROGRESS_STEPS } from "../format.ts";
import type { Progress } from "../ws.ts";

export interface StatusBarProps {
  connected: boolean;
  phase: ReaderState;
  readers: string[];
  progress: Progress | null;
  error: AppError | null;
}

interface StatusCopy {
  title: string;
  detail: string;
}

function copy(props: StatusBarProps): StatusCopy {
  if (!props.connected) {
    return {
      title: "กำลังเชื่อมต่อ…",
      detail: "รอการเชื่อมต่อกับเซิร์ฟเวอร์บนเครื่องนี้",
    };
  }

  switch (props.phase) {
    case "no-reader":
      return {
        title: "ไม่พบเครื่องอ่านบัตร",
        detail: "ตรวจสอบสาย USB แล้วเสียบเครื่องอ่านอีกครั้ง",
      };
    case "waiting-card":
      return {
        title: "พร้อมอ่านบัตร",
        detail: "เสียบบัตรประชาชนเข้าไปในเครื่องอ่าน",
      };
    case "reading": {
      const step = PROGRESS_STEPS.find((info) => info.step === props.progress?.step);
      return {
        title: "กำลังอ่านบัตร…",
        detail: step?.label ?? "กำลังเริ่มอ่านข้อมูล",
      };
    }
    case "ready":
      return {
        title: "อ่านบัตรสำเร็จ",
        detail: "นำบัตรออกเมื่อต้องการล้างข้อมูลบนหน้าจอ",
      };
    case "error":
      return {
        title: "อ่านบัตรไม่สำเร็จ",
        detail: props.error?.message ?? "ลองอีกครั้ง",
      };
  }
}

export function StatusBar(props: StatusBarProps) {
  const text = (): StatusCopy => copy(props);
  const phase = (): string => (props.connected ? props.phase : "connecting");

  return (
    <section class="status" data-phase={phase()} aria-labelledby="status-title">
      <span class="status__dot" aria-hidden="true" />
      <div class="status__body">
        <p class="status__title" id="status-title" role="status">
          {text().title}
        </p>
        <p class="status__sub">{text().detail}</p>
      </div>
      <Show when={props.connected && props.readers.length > 0}>
        <p class="status__reader" title={props.readers.join("\n")}>
          {props.readers[0]}
        </p>
      </Show>
    </section>
  );
}

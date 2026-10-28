/**
 * A failed read is terminal until the user presses retry or replaces the
 * card; showing the code next to the Thai message makes a demo recovery
 * possible without opening the console.
 */
import { Show } from "solid-js";
import type { AppError } from "#shared/protocol.ts";

export interface ErrorPanelProps {
  error: AppError;
  busy: boolean;
  onRetry: () => void;
}

export function ErrorPanel(props: ErrorPanelProps) {
  return (
    <section class="panel error-panel" role="alert" aria-labelledby="error-title">
      <span class="error-panel__icon" aria-hidden="true">
        !
      </span>
      <div class="error-panel__body">
        <h2 id="error-title">อ่านบัตรไม่สำเร็จ</h2>
        <p class="error-panel__message">{props.error.message}</p>

        <Show when={props.error.sw !== undefined || props.error.pcscCode !== undefined}>
          <p class="error-panel__code">
            {props.error.sw !== undefined ? `รหัส SW: ${props.error.sw}` : ""}
            {props.error.sw !== undefined && props.error.pcscCode !== undefined ? " · " : ""}
            {props.error.pcscCode !== undefined ? `รหัส PC/SC: ${props.error.pcscCode}` : ""}
          </p>
        </Show>

        <button
          type="button"
          class="button button--primary"
          onClick={props.onRetry}
          disabled={props.busy}
        >
          {props.busy ? "กำลังลองใหม่…" : "ลองอีกครั้ง"}
        </button>
      </div>
    </section>
  );
}

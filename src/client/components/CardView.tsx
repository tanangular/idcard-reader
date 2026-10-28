/**
 * Everything the card carries, except the ATR which is tucked into a
 * disclosure for demos and support. The card object only exists in memory:
 * removing the card clears it on the server, which clears this view.
 */
import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import type { ThaiIdCard } from "#shared/protocol";
import {
  formatCitizenId,
  formatDateTime,
  formatEnglishName,
  formatSex,
  formatThaiDate,
  formatThaiName,
} from "#client/format";
import { Photo } from "./Photo";

interface FieldProps {
  label: string;
  wide?: boolean;
  children: JSX.Element;
}

function Field(props: FieldProps) {
  return (
    <div class={props.wide ? "field field--wide" : "field"}>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </div>
  );
}

export function CardView(props: { card: ThaiIdCard }) {
  return (
    <article class="panel card-view" aria-labelledby="card-name">
      <div class="card-view__photo">
        <Photo src={props.card.photo.dataUrl} alt="รูปถ่ายจากบัตรประชาชน" />
      </div>

      <div class="card-view__body">
        <p class="eyebrow">บัตรประจำตัวประชาชน</p>
        <h2 id="card-name">{formatThaiName(props.card.nameTh)}</h2>
        <Show when={props.card.nameEn}>
          {(name) => (
            <p class="card-view__en" lang="en">
              {formatEnglishName(name())}
            </p>
          )}
        </Show>

        <dl class="field-grid">
          <Field label="เลขประจำตัวประชาชน">
            <span class="mono">{formatCitizenId(props.card.citizenId)}</span>
          </Field>
          <Field label="วันเกิด">
            <time datetime={props.card.dateOfBirth}>{formatThaiDate(props.card.dateOfBirth)}</time>
          </Field>
          <Field label="เพศ">{formatSex(props.card.sex)}</Field>

          <Field label="ที่อยู่" wide>
            {props.card.address}
          </Field>

          <Field label="วันออกบัตร">
            <time datetime={props.card.issueDate}>{formatThaiDate(props.card.issueDate)}</time>
          </Field>
          <Field label="วันหมดอายุ">
            <time datetime={props.card.expireDate}>{formatThaiDate(props.card.expireDate)}</time>
          </Field>
          <Field label="ผู้ออกบัตร">{props.card.issuer}</Field>
        </dl>

        <details class="card-view__tech">
          <summary>รายละเอียดทางเทคนิค</summary>
          <dl class="field-grid">
            <Field label="อ่านเมื่อ">
              <time datetime={props.card.readAt}>{formatDateTime(props.card.readAt)}</time>
            </Field>
            <Field label="ATR">
              <span class="mono mono--wrap">{props.card.atr}</span>
            </Field>
          </dl>
        </details>
      </div>
    </article>
  );
}

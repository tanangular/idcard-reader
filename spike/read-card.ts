/**
 * Step 4 verification: read the physical card end to end through
 * readThaiIdCard and report timing plus structural facts only.
 *
 * No field value is printed. Extend this script carefully: its output can
 * land in a terminal log or a bug report.
 */
import { formatAtr, Pcsc } from "#server/pcsc.ts";
import { readThaiIdCard } from "#server/thai-card.ts";
import type { ProgressStep } from "#shared/protocol.ts";

const ok = (value: boolean) => (value ? "yes" : "no");
const hasTh = (value: string) => /[\u0e00-\u0e7f]/.test(value);

const pcsc = new Pcsc();
const reader = pcsc.listReaders()[0];
if (!reader) throw new Error("no reader");

const handle = pcsc.connect(reader);

try {
  const atr = formatAtr(pcsc.status(handle).atr);
  const started = Date.now();
  let last: ProgressStep | undefined;

  const card = readThaiIdCard(
    { atrHex: atr, transmit: (apdu) => pcsc.transmit(handle, apdu) },
    {
      onProgress: (step, pct) => {
        if (step !== last) {
          console.log(`  ${step.padEnd(8)} ${String(pct).padStart(3)}%`);
          last = step;
        }
      },
    },
  );

  const elapsed = Date.now() - started;
  const photoBytes = Buffer.from(card.photo.dataUrl.split(",")[1]!, "base64").length;
  const DATE = /^\d{4}-\d{2}-\d{2}$/;
  const KNOWN_PREFIXES = new Set(["นาย", "นาง", "นางสาว", "Mr.", "Mrs.", "Miss"]);

  // Every value below is a length, a boolean or an enum — never a field.
  // tests/privacy.test.ts fails the build if a console call mentions `card`.
  const cidLength = card.citizenId.length;
  const cidIsDigits = /^\d{13}$/.test(card.citizenId);
  const thPrefixKnown = KNOWN_PREFIXES.has(card.nameTh.prefix);
  const thFirstLength = card.nameTh.firstName.length;
  const thLastLength = card.nameTh.lastName.length;
  const thIsThai = hasTh(card.nameTh.firstName);
  const en = card.nameEn;
  const enSummary =
    en === null
      ? "absent"
      : `prefixKnown=${ok(KNOWN_PREFIXES.has(en.prefix))}, first=${en.firstName.length} chars, last=${en.lastName.length} chars`;
  const dobValid = DATE.test(card.dateOfBirth);
  const sexKnown = card.sex !== "unknown";
  const issuerLength = card.issuer.length;
  const issuerIsThai = hasTh(card.issuer);
  const issueValid = DATE.test(card.issueDate);
  const expireValid = DATE.test(card.expireDate);
  const addressLength = card.address.length;
  const addressIsThai = hasTh(card.address);
  const photoMime = card.photo.mime;
  const readAt = card.readAt;

  console.log(`\nelapsed    : ${elapsed} ms`);
  console.log(`citizenId  : length=${cidLength}, digits13=${ok(cidIsDigits)}`);
  console.log(
    `nameTh     : prefixKnown=${ok(thPrefixKnown)}, first=${thFirstLength} chars, last=${thLastLength} chars, thai=${ok(thIsThai)}`,
  );
  console.log(`nameEn     : ${enSummary}`);
  console.log(`dateOfBirth: formatValid=${ok(dobValid)}`);
  console.log(`sex        : known=${ok(sexKnown)}`);
  console.log(`issuer     : length=${issuerLength}, thai=${ok(issuerIsThai)}`);
  console.log(`issueDate  : formatValid=${ok(issueValid)}`);
  console.log(`expireDate : formatValid=${ok(expireValid)}`);
  console.log(`address    : ${addressLength} chars, thai=${ok(addressIsThai)}`);
  console.log(`photo      : ${photoBytes} bytes, mime=${photoMime}`);
  console.log(`atr        : ${atr}`);
  console.log(`readAt     : ${readAt}`);
} finally {
  pcsc.disconnect(handle);
  pcsc.release();
}

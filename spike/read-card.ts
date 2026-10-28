/**
 * Step 4 verification: read the physical card end to end through
 * readThaiIdCard and report timing plus non-sensitive shape information.
 */
import { formatAtr, Pcsc } from "../src/server/pcsc.ts";
import { readThaiIdCard } from "../src/server/thai-card.ts";
import type { ProgressStep } from "../src/shared/protocol.ts";

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

  console.log(`\nelapsed    : ${elapsed} ms`);
  console.log(
    `citizenId  : ${"*".repeat(11)}${card.citizenId.slice(-2)} (${card.citizenId.length} digits)`,
  );
  console.log(
    `nameTh     : ${card.nameTh.prefix} ${card.nameTh.firstName.slice(0, 1)}… (${card.nameTh.firstName.length}/${card.nameTh.lastName.length} chars)`,
  );
  console.log(
    `nameEn     : ${card.nameEn ? `${card.nameEn.prefix} ${card.nameEn.firstName.slice(0, 1)}…` : "absent"}`,
  );
  console.log(`dateOfBirth: ${card.dateOfBirth}`);
  console.log(`sex        : ${card.sex}`);
  console.log(`issuer     : ${card.issuer}`);
  console.log(`issueDate  : ${card.issueDate}`);
  console.log(`expireDate : ${card.expireDate}`);
  console.log(`address    : ${card.address.length} chars`);
  console.log(`photo      : ${photoBytes} bytes, mime=${card.photo.mime}`);
  console.log(`atr        : ${card.atr}`);
  console.log(`readAt     : ${card.readAt}`);
} finally {
  pcsc.disconnect(handle);
  pcsc.release();
}

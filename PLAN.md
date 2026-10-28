# แผน: idcard-reader demo (อ่านบัตรประชาชนไทยผ่าน browser)

สถานะ: **plan mode — ยังไม่เริ่ม implement**
วันที่: 2026-10-28
โฟลเดอร์โปรเจกต์: `/Users/tan/Web/temp/idcard-reader` (เดิมว่าง มีแค่ `.idea/`)

---

## 1. เป้าหมาย

เดโมอ่านบัตรประชาชนไทย (smart card) ผ่านเบราว์เซอร์ ด้วย WebSocket ไปยัง service บนเครื่องเดียวกัน
แสดงผลบนจอ: สถานะเครื่องอ่าน → ความคืบหน้าขณะอ่าน → ข้อมูลบัตร + รูปถ่าย → ล้างจอเมื่อถอดบัตร
พร้อมหน้า `/history` แสดงประวัติการอ่าน (audit log ที่ไม่มี PII)

---

## 2. การตัดสินใจที่ล็อกแล้ว

| # | หัวข้อ | สรุป |
|---|---|---|
| 1 | Package manager / runtime | **bun** ทำทุกอย่าง (ไม่มี pnpm) |
| 2 | ชั้น PC/SC | **koffi** FFI → `PCSC.framework` ตรง ๆ ไม่มี native build |
| 3 | Topology | dev: Vite :5173 proxy `/ws` → Bun :3000 · prod: Bun serve `dist/` + `/ws` |
| 4 | Protocol | typed RPC + server push บน socket เดียว (`shared/protocol.ts`) |
| 5 | ขอบเขตข้อมูล | ครบทุก CDE + รูปถ่าย · ข้อความไทยผ่าน `iconv-lite` (TIS-620) |
| 6 | State | server เป็น state machine + อ่านอัตโนมัติเมื่อเสียบบัตร |
| 7 | SQLite | `bun:sqlite` เก็บ **audit log ไม่มี PII** + `cid_hash` (salted SHA-256) |
| 8 | ความปลอดภัย | bind `127.0.0.1` + `Origin` allowlist |
| 9 | Refresh | in-memory snapshot push ตอน connect, ล้างเมื่อถอดบัตร |
| 10 | โครงสร้าง | `shared / server / client / tests` + `bun run --parallel` |
| 11 | Routing | มี 2 หน้า: `/` (live) และ `/history` (audit) → ใช้ `@solidjs/router` |
| 12 | ภาษา UI | **ไทยล้วน** (ข้อความ error, label, สถานะ) |

---

## 3. เวอร์ชัน (pin ตายตัว ไม่ใช้ `^` กับ `next`)

```jsonc
{
  "dependencies": {
    "solid-js": "2.0.0-rc.19",
    "@solidjs/router": "2.0.0-next.43",
    "koffi": "3.3.5",
    "iconv-lite": "0.7.3"
  },
  "devDependencies": {
    "vite": "8.3.5",
    "vite-plugin-solid": "3.0.0-next.27",
    "typescript": "7.0.2",
    "oxlint": "1.90.0",
    "oxfmt": "0.75.0"
  }
}
```

หมายเหตุ: `solid-js` stable ล่าสุดคือ 1.9.17 — 2.0 ยังเป็น RC (`next` = 2.0.0-rc.19)
`@solidjs/router` latest 1.0.0 ไม่รองรับ Solid 2.0 จึงต้องใช้ `next` คู่กัน

---

## 4. สถาปัตยกรรม

```
┌──────────────── browser ────────────────┐
│ Solid 2.0 (Vite :5173 dev / :3000 prod) │
│  /         live reader view             │
│  /history  audit timeline               │
└──────────────────┬──────────────────────┘
                   │ ws://127.0.0.1:3000/ws  (Origin allowlist)
┌──────────────────▼──────────────────────┐
│ Bun.serve — src/server/main.ts          │
│  ├─ state.ts     state machine          │
│  ├─ thai-card.ts APDU sequence          │
│  ├─ cde.ts       pure parser            │
│  ├─ audit.ts     bun:sqlite             │
│  └─ pcsc.ts      koffi FFI              │
└──────────────────┬──────────────────────┘
                   │ SCardTransmit
        PCSC.framework ──► EMV Smartcard Reader ──► บัตร ปชช. ไทย
```

**SPA fallback:** Bun ต้องเสิร์ฟ `dist/index.html` สำหรับ path ที่ไม่ใช่ `/ws` และไม่ใช่ไฟล์ static
(เพื่อให้ refresh ที่ `/history` ไม่ 404)

---

## 5. Protocol (`src/shared/protocol.ts`)

```ts
// client → server
type ClientMsg =
  | { id: string; type: "readers.list" }
  | { id: string; type: "card.read" }
  | { id: string; type: "history.list"; limit: number; offset: number };

// server → client
type ServerMsg =
  | { id: string; type: "readers.list"; ok: true; readers: string[] }
  | { id: string; type: "card.read"; ok: true; card: ThaiIdCard }
  | { id: string; type: "card.read"; ok: false; error: AppError }
  | { id: string; type: "history.list"; ok: true; rows: AuditRow[]; total: number }
  | { id: string; type: "history.list"; ok: false; error: AppError }
  | { type: "card.snapshot"; card: ThaiIdCard }          // push ตอน connect
  | { type: "card.inserted"; reader: string }             // push
  | { type: "card.removed"; reader: string }              // push
  | { type: "card.progress"; step: ProgressStep; pct: number };

type ProgressStep = "select" | "cid" | "name" | "address" | "photo";
```

หลักการ:
- message ที่ตอบคำถามมี `id` (correlate ได้) · push event ไม่มี `id`
- `card.progress` จำเป็นเพราะอ่านรูปใช้เวลา ~1–2 วินาที
- type ชุดเดียวใช้ทั้ง server และ client → เปลี่ยน field แล้ว typecheck พังทันที

---

## 6. Type ข้อมูล

```ts
export type Sex = "male" | "female" | "unknown";

export interface ThaiIdCard {
  citizenId: string;          // อยู่ใน memory เท่านั้น ห้ามลงดิสก์ ห้าม log
  nameTh: { prefix: string; firstName: string; middleName: string | null; lastName: string };
  nameEn: { prefix: string; firstName: string; middleName: string | null; lastName: string } | null;
  dateOfBirth: string;        // YYYY-MM-DD
  sex: Sex;
  address: string;
  issueDate: string;
  expireDate: string;
  issuer: string;
  photo: { mime: "image/jpeg"; dataUrl: string };
  atr: string;                // hex
  readAt: string;             // ISO8601
}

export type AppErrorCode =
  | "NO_READER" | "NO_CARD" | "CARD_REMOVED" | "SHARING_VIOLATION"
  | "NOT_THAI_ID" | "SECURITY_STATUS" | "TRANSMIT_FAILED"
  | "PARSE_FAILED" | "UNKNOWN";

export interface AppError {
  code: AppErrorCode;
  message: string;            // ข้อความไทยสำหรับ UI
  sw?: string;                // "6A82"
  pcscCode?: string;          // "0x80100069"
}

// ห้ามมี PII ใน type นี้
export interface AuditRow {
  id: number;
  at: string;
  reader: string;
  outcome: "ok" | "error";
  errorCode: AppErrorCode | null;
  durationMs: number;
  cidHashShort: string;       // 8 ตัวแรกของ salted hash
}
```

---

## 7. CDE ที่จะอ่าน

| CDE | offset | length | หมายเหตุ |
|---|---|---|---|
| Citizen ID | `0x0004` | 13 | ASCII |
| ชื่อ-สกุล (ไทย) | `0x0011` | 211 | TIS-620 คั่นด้วย `#` |
| ชื่อ-สกุล (อังกฤษ) | `0x0075` | 100 | ASCII |
| วันเกิด | `0x00D9` | 8 | `YYYYMMDD` |
| เพศ | `0x00E1` | 1 | `1`=ชาย `2`=หญิง |
| ผู้ออกบัตร | `0x00F6` | 100 | TIS-620 |
| วันออกบัตร | `0x00DA` | 8 | |
| วันหมดอายุ | `0x00E2` | 8 | |
| ที่อยู่ | `0x00EF` | 100 | TIS-620 |
| รูปถ่าย | `0x0001` | ~20KB | JPEG · อ่าน header 20 ไบต์ก่อนแล้ว chunk |

**APDU**
- SELECT applet: `00 A4 04 00 08 A0 00 00 00 54 48 00 01`
- READ: `80 B0 <offHi> <offLo> 02 <lenHi> <lenLo>`
- **ต้องจัดการ `61 XX` (GET RESPONSE: `00 C0 00 00 XX`) และ `6C XX`** — บัตรนี้เป็น T=0 เท่านั้น (ดูข้อ 15)
- รูป: อ่านทีละ chunk (~0xFF ไบต์) พร้อม timeout ต่อคำสั่ง
- encoding ข้อความไทย: `iconv-lite` → `windows-874` / `tis620` (ไม่ใช้ `TextDecoder` เพราะ Bun อาจไม่รองรับ)

**Error mapping**

| code | ค่า | ความหมาย |
|---|---|---|
| `SCARD_E_NO_READERS_AVAILABLE` | `0x8010002E` | ไม่พบเครื่องอ่านบัตร |
| `SCARD_E_NO_SMARTCARD` | `0x8010000C` | ยังไม่ได้เสียบบัตร |
| `SCARD_W_REMOVED_CARD` | `0x80100069` | บัตรถูกถอดระหว่างอ่าน |
| `SCARD_E_SHARING_VIOLATION` | `0x8010000B` | มีโปรแกรมอื่นถือบัตร (retry 1 ครั้ง) |
| `SW=6A82` | — | ไม่ใช่บัตรประชาชนไทย |
| `SW=6982` | — | สถานะความปลอดภัยไม่ถูกต้อง |

---

## 8. State machine

```
idle ──► no-reader ──(เสียบ reader)──► waiting-card
  ▲                                        │
  │                                   (เสียบบัตร)
  │                                        ▼
  └──(ถอด reader)── reading ──► ready ──► (ถอดบัตร) ──► waiting-card
                      │
                   (error) ──► error ──(retry)──► reading
```

- ตรวจจับ insert/remove ด้วย **poll `SCardGetStatusChange` ทุก 500 ms แบบ timeout = 0**
  (ไม่ใช้ `INFINITE` เพราะจะบล็อก thread ของ Bun)
- server เป็นเจ้าของ state, client เป็นผู้ render เท่านั้น
- snapshot ใน memory ล้างทันทีเมื่อ `card.removed`

---

## 9. SQLite schema (`data/audit.db`, gitignored)

```sql
CREATE TABLE IF NOT EXISTS read_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT    NOT NULL,   -- ISO8601
  reader      TEXT    NOT NULL,
  outcome     TEXT    NOT NULL,   -- 'ok' | 'error'
  error_code  TEXT,
  duration_ms INTEGER NOT NULL,
  cid_hash    TEXT                -- SHA-256(salt + CID)
);
CREATE INDEX IF NOT EXISTS idx_read_events_at ON read_events(at DESC);
```

- salt มาจาก env `AUDIT_SALT` (ถ้าไม่ตั้ง ใช้ค่าสุ่มที่เก็บใน memory → hash ใช้ข้ามรอบไม่ได้ แต่ปลอดภัยกว่า)
- **ห้ามเก็บ**: เลขบัตร, ชื่อ, ที่อยู่, วันเกิด, รูป
- `/history` อ่านจากตารางนี้เท่านั้น

---

## 10. โครงสร้างไฟล์

```
idcard-reader/
├── package.json
├── tsconfig.json            # strict, noUncheckedIndexedAccess
├── vite.config.ts           # solid plugin + proxy /ws → :3000 (ws: true)
├── .oxlintrc.json
├── .gitignore
├── index.html
├── README.md
├── src/
│   ├── shared/protocol.ts
│   ├── server/
│   │   ├── main.ts          # Bun.serve + WS hub + Origin guard + SPA fallback
│   │   ├── pcsc.ts          # koffi: EstablishContext/ListReaders/Connect/Transmit/GetStatusChange
│   │   ├── thai-card.ts     # ลำดับ APDU + GET RESPONSE + photo chunking
│   │   ├── cde.ts           # pure parser: TIS-620, วันที่, แยกชื่อ, ประกอบที่อยู่
│   │   ├── state.ts         # state machine (inject PcscPort)
│   │   ├── audit.ts         # bun:sqlite
│   │   └── errors.ts        # PC/SC code → AppError
│   └── client/
│       ├── index.tsx
│       ├── App.tsx          # <Router>
│       ├── routes/Live.tsx
│       ├── routes/History.tsx
│       ├── ws.ts            # typed client + reconnect
│       └── components/{CardView,Photo,StatusBar,Timeline,ErrorPanel}.tsx
├── tests/
│   ├── cde.test.ts          # hex fixture → ข้อมูลที่คาดหวัง (ไม่ต้องมีบัตร)
│   ├── protocol.test.ts
│   ├── state.test.ts        # fake PcscPort: เสียบบัตร/ถอดกลางคัน/reader หลุด
│   └── audit.test.ts        # ยืนยันว่าไม่มี PII ลงตาราง
└── data/audit.db
```

---

## 11. สคริปต์

```json
{
  "scripts": {
    "dev":         "bun run --parallel dev:server dev:client",
    "dev:server":  "bun --watch src/server/main.ts",
    "dev:client":  "vite",
    "build":       "vite build",
    "start":       "NODE_ENV=production bun src/server/main.ts",
    "test":        "bun test",
    "lint":        "oxlint",
    "fmt":         "oxfmt",
    "fmt:check":   "oxfmt --check",
    "typecheck":   "tsc --noEmit"
  }
}
```

`oxfmt` เป็น zero-config ตามค่าเริ่มต้น — จะเพิ่ม `.oxfmtrc.json` เฉพาะเมื่อต้องการปรับ

---

## 12. ลำดับลงมือ + เกณฑ์ผ่าน

| ขั้น | งาน | ผ่านเมื่อ |
|---|---|---|
| **0** | **Spike: `bun add koffi` → `SCardEstablishContext` + `SCardListReaders`** | พิมพ์ `Generic EMV Smartcard Reader` ได้ · ถ้าไม่ผ่าน → fallback `thai-smartcard` |
| 1 | Scaffold: package.json, tsconfig, vite.config, oxlint/oxfmt, protocol.ts | `lint` + `typecheck` + `build` ผ่าน |
| 2 | `pcsc.ts` + CLI probe `--list` / `--status` | ผลตรงกับ `system_profiler SPSmartCardsDataType` (เห็น ATR) |
| 3 | `cde.ts` + tests ด้วย hex fixture | `bun test` ผ่านโดยไม่ต้องมีบัตร |
| 4 | `thai-card.ts` — APDU + `61 XX` + photo chunk | อ่านบัตรจริงได้ครบทุก field |
| 5 | `state.ts` + fake `PcscPort` | test ครอบ insert / remove กลางคัน / reader หลุด / retry |
| 6 | `audit.ts` + test | dump DB แล้วไม่มีเลขบัตร/ชื่อ/ที่อยู่/รูป |
| 7 | `main.ts` — WS + Origin guard + snapshot + progress + SPA fallback | `wscat` ต่อได้ · Origin แปลกได้ 403 · refresh `/history` ไม่ 404 |
| 8 | Client — `/` live view | demo flow ครบ: เสียบบัตร → progress → ข้อมูล → ถอด → ล้างจอ |
| 9 | Client — `/history` | ตารางโหลดจาก WS, แบ่งหน้าได้, ไม่มี PII |
| 10 | Hardening: `bun run build && bun run start` + README | เปิดจาก `:3000` คำสั่งเดียว |

---

## 13. ความเสี่ยง

| ความเสี่ยง | ระดับ | มาตรการ |
|---|---|---|
| koffi กับ Bun 1.4.4 ไม่เข้ากัน | สูง | ขั้น 0 แก้ก่อน · fallback `thai-smartcard` 1.0.28 (napi prebuilt) |
| Solid 2.0 RC เปลี่ยน API | กลาง | pin exact · ใช้ ecosystem lib เท่าที่จำเป็น (router ตัวเดียว) |
| TS 7.0.2 (native rewrite) ยังใหม่ | กลาง | ถ้า typecheck/plugin มีปัญหา ถอยไป TS 6.x |
| APDU offset/length คลาดเคลื่อน | กลาง | ค่าคงที่รวมที่ `cde.ts` + fixture test + ยืนยันกับบัตรจริงขั้น 4 |
| อ่านรูปค้าง (Le limit / GET RESPONSE) | **กลาง-สูง** | บัตรเป็น T=0 → ต้อง handle `61 XX`/`6C XX` ทุกครั้ง + chunk ~0xFF + timeout ต่อ APDU |
| `SCARD_E_SHARING_VIOLATION` จาก CryptoTokenKit | ต่ำ-กลาง | `SCARD_SHARE_SHARED` + retry 1 ครั้ง |
| Bun ยังไม่รองรับ `TextDecoder("windows-874")` | ต่ำ | ใช้ `iconv-lite` ตั้งแต่แรก |

---

## 14. Privacy / PDPA checklist

- [ ] เลขบัตร/ชื่อ/ที่อยู่/วันเกิด/รูป **ไม่อยู่ใน** DB, log, error message, URL
- [ ] `citizenId` อยู่ใน memory ของ server เท่านั้น และถูกล้างเมื่อถอดบัตร
- [ ] audit เก็บเฉพาะ `cid_hash` (salted SHA-256) + metadata
- [ ] ไม่มี `console.log(card)` ที่ไหนในโค้ด
- [ ] WS bind `127.0.0.1` + ตรวจ `Origin` allowlist
- [ ] ไม่มี CORS wildcard
- [ ] `data/` อยู่ใน `.gitignore`
- [ ] README ระบุชัดว่านี่คือ demo ไม่ใช่ระบบสำหรับใช้งานจริง

---

## 15. สถานะ hardware (ตรวจเมื่อ 2026-10-28)

- Reader: `Generic EMV Smartcard Reader` · VID `0x2CE3` / PID `0x9563` · CCID driver `ifd-ccid 1.5.1` ✅
- บัตร: **เสียบอยู่** ✅
- ATR: `3B 79 96 00 00 54 48 20 4E 49 44 20 31 37`

**ถอด ATR:**

| ไบต์ | ค่า | ความหมาย |
|---|---|---|
| `3B` | TS | direct convention |
| `79` | T0 | มี TA1/TB1/TC1 (Y1=0x7), historical 9 ไบต์, ไม่มี TD1 |
| `96` | TA1 | Fi=9, Di=6 → f=512, I=32 (รองรับความเร็วสูง) |
| `00` | TB1 | ไม่ต้องใช้ programming voltage, ไม่มี waiting time extension |
| `00` | TC1 | ไม่มี error detection, guard time = 0 |
| `54 48 20 4E 49 44 20 31 37` | historical | ASCII = **`TH NID 17`** (Thai National ID) |

**ผลต่อการ implement:**
1. เป็นบัตรประชาชนไทยจริง (ยืนยันจาก historical bytes) — ชื่อ reader ที่ขึ้นว่า "EMV" เป็นแค่ชื่อ generic ของ hardware
2. **มีแค่ T=0** → การจัดการ `61 XX` (GET RESPONSE) และ `6C XX` เป็นสิ่งจำเป็น ไม่ใช่ทางเลือก
3. TA1 = `0x96` → บัตรรองรับ baud สูง ถ้าอ่านรูปเกิน 2 วินาทีแปลว่า chunk เล็กเกินไป

สภาพแวดล้อม: macOS 27.0.1 · Bun 1.4.4 · Node 26.12.1 · Xcode CLT ✅ · `PCSC.framework` ✅ · `bun:sqlite` (SQLite 3.54.0) ✅

---

## 16. ขั้นถัดไป

1. ผู้ใช้สลับ agent ออกจาก plan mode
2. เริ่ม **ขั้น 0 (spike koffi)** และรายงานผลก่อนไปขั้น 1
3. ถ้า spike ผ่าน → เดินหน้าตามลำดับในหัวข้อ 12

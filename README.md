# idcard-reader — เดโมอ่านบัตรประชาชนไทยผ่านเบราว์เซอร์

> **เดโมสำหรับสาธิตเท่านั้น ไม่ใช่ระบบสำหรับใช้งานจริง**
>
> โค้ดชุดนี้ไม่มีระบบยืนยันตัวตน การเชื่อมต่อ local เป็น HTTP/WS บน loopback (Vercel ใช้ TLS ของแพลตฟอร์ม)
> ไม่มี rate limit ไม่มีผู้ใช้หลายคน และไม่ได้ผ่านการตรวจสอบความปลอดภัยใด ๆ
> ห้ามนำไปใช้เก็บหรือประมวลผลข้อมูลบัตรของผู้อื่นโดยไม่ได้รับความยินยอม

เดโมนี้เสียบบัตรประชาชนไทยเข้าเครื่องอ่าน แล้วเปิดหน้าเว็บเพื่อดูข้อมูลบนบัตรพร้อมรูปถ่าย
ระบบจะอ่านบัตรอัตโนมัติเมื่อเสียบบัตร แสดงความคืบหน้าระหว่างอ่าน และล้างข้อมูลทันทีเมื่อถอดบัตร
พร้อมหน้า `/history` ที่แสดงเฉพาะข้อมูลเมตาของการอ่าน (ไม่มีข้อมูลส่วนบุคคล)

ข้อมูลบัตรอยู่ในหน่วยความจำของเซิร์ฟเวอร์ที่รันแอปและเบราว์เซอร์ที่เปิดหน้าเว็บเท่านั้น
ไม่ถูกเขียนลงดิสก์หรือส่งไปยังบริการอื่น บน Vercel ไม่มีเครื่องอ่านบัตร จึงไม่มีข้อมูลบัตรจริงใน deployment

---

## ต้องมีอะไรบ้าง

| สิ่งที่ต้องมี     | รายละเอียด                                                              |
| ----------- | ---------------------------------------------------------------------- |
| ระบบปฏิบัติการ | macOS (โค้ดเรียก `PCSC.framework` ตามพาธของ macOS)                       |
| Runtime     | [Bun](https://bun.sh) 1.4.4                                            |
| เครื่องอ่านบัตร | smart card reader ที่รองรับ CCID (ทดสอบกับ `Generic EMV Smartcard Reader`) |
| บัตร         | บัตรประชาชนไทยแบบ smart card (ทดสอบกับบัตรรุ่นปี 2567)                       |

ไม่ต้อง build native module — ชั้น PC/SC เรียกผ่าน FFI (`koffi`) เข้ากับ framework ของระบบโดยตรง

---

## เริ่มใช้งาน

```bash
bun install

# โหมดพัฒนา: Bun :3000 + Vite :5173 (proxy /ws ไปที่ :3000)
bun run dev
# เปิด http://localhost:5173

# โหมด production: Bun เสิร์ฟ dist/ และ /ws ที่พอร์ตเดียว
bun run build
bun run start
# เปิด http://127.0.0.1:3000
```

ถ้าเปิด `:3000` ในโหมด dev ก่อน `bun run build` จะเห็นหน้าแจ้งว่า `dist/` ยังไม่มี — ให้ใช้ `:5173` หรือ build ก่อน

### คำสั่งที่มี

| คำสั่ง                        | ทำอะไร                                |
| --------------------------- | ------------------------------------- |
| `bun run dev`               | รันเซิร์ฟเวอร์ (watch) และ Vite พร้อมกัน    |
| `bun run build`             | สร้างไฟล์หน้าเว็บลง `dist/`               |
| `bun run start`             | เสิร์ฟ `dist/` + WebSocket ที่พอร์ต 3000   |
| `bun test`                  | รันชุดทดสอบทั้งหมด (ไม่ต้องมีบัตรหรือเครื่องอ่าน) |
| `bun run typecheck`         | ตรวจ TypeScript                       |
| `bun run lint`              | ตรวจด้วย oxlint                        |
| `bun run fmt` / `fmt:check` | จัดรูปแบบ / ตรวจรูปแบบด้วย oxfmt          |
| `bun run probe --status`    | ดูสถานะเครื่องอ่านและ ATR จาก terminal    |
| `bun run probe --list`      | ดูรายชื่อเครื่องอ่าน                        |
| `bun run probe --events`    | เฝ้าดูการเสียบ/ถอดบัตร 5 วินาที             |

---

## ตั้งค่า (environment variables)

| ตัวแปร             | ค่าเริ่มต้น                                                             | ความหมาย                                                                          |
| ----------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `HOST`            | `127.0.0.1` (local), `0.0.0.0` (Vercel)                             | ที่อยู่ที่เซิร์ฟเวอร์ bind — local อย่าเปลี่ยนเป็น `0.0.0.0`; container ต้องใช้ `0.0.0.0`        |
| `PORT`            | `3000` (local), `80` (Vercel)                                       | พอร์ตของ Bun                                                                       |
| `AUDIT_DB`        | `data/audit.db` (local), `/tmp/idcard-audit.db` (Vercel)            | พาธไฟล์ SQLite ของ audit log                                                       |
| `AUDIT_SALT`      | สุ่มใหม่ทุก process                                                     | salt สำหรับแฮชเลขบัตร — ตั้งค่าเพื่อให้แฮชเทียบข้ามการรีสตาร์ทได้ (ค่าว่างถือว่าไม่ได้ตั้ง)            |
| `ALLOWED_ORIGINS` | local: loopback + Vite `:5173`; Vercel: `https://<deployment host>` | รายการ Origin ที่อนุญาตให้เปิด WebSocket (คั่นด้วย comma) — ถ้าตั้ง จะ **แทนที่** ค่าเริ่มต้นทั้งหมด |

ตัวอย่าง:

```bash
AUDIT_SALT="$(openssl rand -hex 32)" bun run start
```

ค่า salt ไม่ถูกเขียนลงฐานข้อมูล ถ้าไม่ตั้ง `AUDIT_SALT` ทุกครั้งที่รีสตาร์ทแฮชของบัตรเดียวกันจะเปลี่ยน
(ยอมแลกความต่อเนื่องเพื่อความเป็นส่วนตัว)

---

## Deploy บน Vercel (Container)

โปรเจกต์มี `Dockerfile` ที่ root และ `vercel.json` ที่ตั้ง `"framework": "container"` เพื่อบังคับให้ Vercel ใช้ Container preset (ไม่ให้ Vite preset ชนะ)

```bash
bunx vercel login
bunx vercel link
bunx vercel --prod
```

สิ่งที่ต้องรู้ก่อน deploy:

- **อ่านบัตรไม่ได้บน Vercel** — container เป็น Linux ไม่มี `PCSC.framework`, ไดรเวอร์ PC/SC หรือเครื่องอ่าน USB ที่ผูกกับเครื่องของคุณ เซิร์ฟเวอร์จะจับ error ตอนโหลดไลบรารีแล้วเข้าสู่โหมด `no-reader` แทนการ crash หน้าเว็บและ history ยังเปิดได้ แต่การอ่านบัตรต้องรันบนเครื่องที่มีเครื่องอ่าน
- **พอร์ต/ที่อยู่** — container bind `0.0.0.0:80` ตามที่ Vercel route ให้ `main.ts` เลือกค่านี้ให้เองเมื่อเจอ `VERCEL_URL` จึงไม่ต้องตั้ง `HOST`/`PORT`
- **Origin** — บน Vercel ค่าเริ่มต้นสร้างจาก `VERCEL_URL`, `VERCEL_BRANCH_URL` และ `VERCEL_PROJECT_PRODUCTION_URL` เป็น `https://...` และ **ไม่รวม localhost** ถ้าใช้ custom domain ต้องเพิ่มใน `ALLOWED_ORIGINS` เช่น `ALLOWED_ORIGINS=https://id.example.com`
- **Audit log ไม่ถาวร** — `AUDIT_DB=/tmp/idcard-audit.db`; `/tmp` หายเมื่อ instance ถูก recycle และแต่ละ instance แยกฐานข้อมูลกัน ถ้าต้องการ history จริงต้องใช้ฐานข้อมูลภายนอก
- **WebSocket มีอายุ** — Vercel Functions ปิด connection เมื่อถึง max duration (Hobby 300 วินาที) client มี reconnect backoff อยู่แล้ว แต่การอ่านที่กำลังทำอยู่อาจถูกตัด
- ตั้ง `AUDIT_SALT` ใน project environment เพื่อให้ hash คงที่ข้ามการรีสตาร์ท

---

## ทำงานอย่างไร

```
เบราว์เซอร์ (Solid 2)
   │  WebSocket /ws  — typed RPC + server push
   ▼
Bun server  ── state machine ──► audit log (SQLite, ไม่มี PII)
   │  koffi FFI
   ▼
PCSC.framework ──► เครื่องอ่าน ──► บัตรประชาชน
```

1. **เซิร์ฟเวอร์เป็นเจ้าของสถานะ** — เบราว์เซอร์ไม่เคยสั่งอ่านบัตรเองและไม่เดาสถานะ
   เซิร์ฟเวอร์จะ poll `SCardGetStatusChange` ทุก 500 ms (timeout 0) และอ่านบัตรอัตโนมัติเมื่อตรวจพบ ATR ใหม่
2. **สถานะ**: `no-reader` → `waiting-card` → `reading` → `ready` (หรือ `error`)
   ถ้าถอดบัตรกลางคันจะกลับไป `waiting-card` โดยไม่ค้างอยู่ในสถานะ error
3. **อ่านข้อมูล**: SELECT แอปพลิเคชันของบัตร แล้วอ่าน CDE ทุกฟิลด์ + รูปถ่าย
   รูปถูกอ่านเป็นก้อน (`61 XX` / `6C XX`, ก้อนละไม่เกิน `0xFF` ไบต์) แล้วรวมเป็น data URL
4. **ข้อความไทย** ถอดรหัสด้วย `iconv-lite` (TIS-620 / windows-874)
5. **วันที่** บนบัตรเป็นพุทธศักราช แปลงเป็น ค.ศ. ก่อนส่ง และหน้าเว็บแสดงเป็น พ.ศ.
6. **เมื่อถอดบัตร** เซิร์ฟเวอร์ล้าง snapshot ในหน่วยความจำและ push `card.removed`
   หน้าเว็บจึงว่างทันที; ถ้าเบราว์เซอร์หลุดการเชื่อมต่อก็ล้างข้อมูลในหน้าจอเช่นกัน
7. **audit log** บันทึกเวลา, ชื่อเครื่องอ่าน, ผลสำเร็จ/ผิดพลาด, รหัสข้อผิดพลาด,
   ระยะเวลา และ `cid_hash` (SHA-256 ของ `salt + เลขบัตร`) — ไม่มีชื่อ ที่อยู่ วันเกิด หรือรูป

### รูปแบบข้อมูลบนสาย

ทุกข้อความเป็น JSON ฝั่งเซิร์ฟเวอร์และไคลเอนต์ใช้ type เดียวกันจาก `src/shared/protocol.ts`:

- คำขอมี `id` และได้รับการตอบกลับที่มี `id` เดียวกัน
- เหตุการณ์ที่เซิร์ฟเวอร์ push (สถานะเครื่องอ่าน, ความคืบหน้า, ข้อมูลบัตร, ข้อผิดพลาด) ไม่มี `id`

---

## ความเป็นส่วนตัว

- [x] เลขบัตร/ชื่อ/ที่อยู่/วันเกิด/รูป **ไม่อยู่ใน** ฐานข้อมูล, log ของแอป, ข้อความ error หรือ URL
- [x] ข้อมูลบัตรอยู่ในหน่วยความจำของเซิร์ฟเวอร์และของแท็บที่เปิดอยู่เท่านั้น (ต้องส่งเลขบัตรไปให้เบราว์เซอร์เพื่อแสดง) และถูกล้างเมื่อถอดบัตรหรือเมื่อหลุดการเชื่อมต่อ
- [x] audit เก็บเฉพาะ `cid_hash` (salted SHA-256) + metadata; หน้าเว็บเห็นแค่ 8 ตัวแรก
- [x] ไม่มี `console.log(card)` ในโค้ด และไม่มี `console.*` ที่พิมพ์ค่าฟิลด์ของบัตร (มี test ตรวจ)
- [x] สคริปต์ใน `spike/` พิมพ์เฉพาะข้อเท็จจริงเชิงโครงสร้าง (ความยาว, true/false) ไม่พิมพ์ค่าฟิลด์
- [x] WebSocket bind loopback เมื่อรันบนเครื่อง และ `0.0.0.0` ใน container พร้อมตรวจ `Origin` allowlist
- [x] บน Vercel ไม่มีเครื่องอ่านบัตร จึงไม่มีข้อมูลบัตรจริงไหลผ่าน deployment
- [x] ไม่มี CORS wildcard
- [x] `data/` อยู่ใน `.gitignore`
- [x] README ระบุชัดว่านี่คือเดโม ไม่ใช่ระบบสำหรับใช้งานจริง

ชุดทดสอบมีเคสที่เปิดไฟล์ฐานข้อมูลที่เขียนจริงแล้วค้นหาเลขบัตร ชื่อ ที่อยู่ วันเกิด และ marker ของรูป
เพื่อยืนยันว่าไม่มีข้อมูลเหล่านี้อยู่บนดิสก์

หน้าเว็บถูกตั้ง `noindex, nofollow` และมี `robots.txt` ที่ห้าม crawler ทั้งหมด

---

## ข้อจำกัดของเดโม

- รองรับเครื่องอ่านเครื่องเดียวและผู้ใช้คนเดียว
- ไม่มีระบบ login — ใครก็ตามที่เข้าถึง `127.0.0.1:3000` บนเครื่องนี้ได้จะเห็นข้อมูลบัตรที่เสียบอยู่
- การเชื่อมต่อ local เป็น HTTP/WS ธรรมดา ไม่มี TLS (อาศัยการ bind loopback เท่านั้น); บน Vercel ใช้ TLS ของแพลตฟอร์ม
- บน Vercel อ่านบัตรไม่ได้เพราะไม่มี PC/SC และ USB reader — ใช้ได้เฉพาะ UI กับ history ที่ไม่ถาวร
- ถ้าโปรแกรมอื่น (เช่น ระบบยืนยันตัวตนของ macOS) ถือบัตรอยู่ จะได้ `SHARING_VIOLATION`
- ตาราง offset ของ CDE อ้างอิงบัตรรุ่นปี 2567 — บัตรรุ่นอื่นอาจต้องแก้ค่าคงที่ใน `src/server/cde.ts`
- ไม่มี retry อัตโนมัติเมื่ออ่านพลาดจากสาเหตุที่ไม่ใช่การถอดบัตร — ผู้ใช้กด "ลองอีกครั้ง" เอง
- **ไม่มี timeout ต่อ APDU** — ถ้าบัตรค้างหรือไดรเวอร์ไม่ตอบ `SCardTransmit` จะบล็อก event loop ของเซิร์ฟเวอร์จนกว่าไดรเวอร์จะหมดเวลาเอง (แผนเดิมระบุไว้แต่ยังไม่ได้ทำ; ทางแก้จริงคือแยกการสนทนากับบัตรไป worker แล้ว kill ตาม deadline ซึ่งเกินขอบเขตเดโม)

---

## แก้ปัญหาที่พบบ่อย

| อาการ                               | สาเหตุ/วิธีแก้                                             |
| ----------------------------------- | ------------------------------------------------------ |
| "ไม่พบเครื่องอ่านบัตร"                   | ตรวจสาย USB แล้วรัน `bun run probe --list`               |
| "มีโปรแกรมอื่นกำลังใช้งานบัตรอยู่"          | ปิดโปรแกรมที่ถือบัตรอยู่ แล้วถอด/เสียบบัตรใหม่                    |
| หน้าเว็บขึ้น "กำลังเชื่อมต่อ…" ตลอด         | เซิร์ฟเวอร์ยังไม่รัน หรือ `ALLOWED_ORIGINS` ไม่มี origin ที่เปิดอยู่ |
| เปิด `:3000` แล้วเห็นหน้า "ยังไม่มี dist/" | โหมด dev ใช้ `:5173` หรือรัน `bun run build` ก่อน          |
| build แล้วหน้าเว็บเก่า                  | เซิร์ฟเวอร์เสิร์ฟไฟล์จาก `dist/` ทุกครั้ง — hard refresh หนึ่งครั้ง |

ตรวจ hardware ด้วย:

```bash
bun run probe --status     # ATR + protocol
bun run probe --events     # เฝ้าดูการเสียบ/ถอดบัตร 5 วินาที
system_profiler SPSmartCardsDataType
```

---

## โครงสร้างโปรเจกต์

```
src/
  shared/protocol.ts     type ของข้อความบนสาย + ตัวแยกข้อความฝั่งเซิร์ฟเวอร์
  server/
    main.ts              composition root (PC/SC จริง, SQLite จริง)
    server.ts            HTTP + WebSocket, origin guard, SPA fallback
    state.ts             state machine + การอ่านอัตโนมัติ
    thai-card.ts         APDU, การอ่าน CDE และรูป
    cde.ts               ตาราง offset/ความยาว + parser
    pcsc.ts              FFI ไปยัง PCSC.framework
    audit.ts             SQLite audit log (ไม่มี PII)
    errors.ts            รหัส PC/SC และข้อความ error ภาษาไทย
  client/
    index.tsx            จุดเริ่มต้น, เชื่อมต่อ socket
    App.tsx              shell, เมนู, skip link
    ws.ts                WebSocket client + reconnect + request correlation
    format.ts            ตัวจัดรูปแบบภาษาไทย
    routes/              Live.tsx, History.tsx
    components/          StatusBar, CardView, Photo, Timeline, ErrorPanel
    styles.css           design tokens, light/dark, responsive
tests/                   การทดสอบทั้งหมดรันได้โดยไม่ต้องมี hardware
spike/                   สคริปต์ทดลองอ่านบัตร (รันมือ ไม่ถูก import โดยแอป; พิมพ์เฉพาะข้อเท็จจริงเชิงโครงสร้าง)
Dockerfile               image สำหรับ Vercel Container (linux/amd64)
.dockerignore            กัน node_modules/dist/data ออกจาก build context
vercel.json              บังคับ framework เป็น container
```

การ import ข้ามโฟลเดอร์ใช้ subpath imports ที่ประกาศไว้ใน `package.json`:

```json
"imports": {
  "#server/*": "./src/server/*.ts",
  "#client/components/*": "./src/client/components/*.tsx",
  "#client/routes/*": "./src/client/routes/*.tsx",
  "#client/*": "./src/client/*.ts",
  "#shared/*": "./src/shared/*.ts"
}
```

เช่น `#server/state`, `#client/ws`, `#shared/protocol` — ฝั่งที่ import ยังไม่ต้องใส่นามสกุลไฟล์ แต่ target ใน `package.json` ต้องระบุนามสกุล `.ts`/`.tsx` เพราะ TypeScript resolve package imports จาก target ตรง ๆ และไม่เติมนามสกุลให้

`tsconfig.json` ไม่มี `paths` แล้ว — `package.json#imports` เป็นแหล่งความจริงเดียวทั้งตอน typecheck, test, dev และ build ส่วน import ภายในโฟลเดอร์เดียวกันยังใช้ relative ตามเดิม

ไฟล์ `.tsx` แยก pattern ตามโฟลเดอร์ (`components/*`, `routes/*`) เพราะ pattern ที่ยาวที่สุดจะชนะ; Bun และ Vite resolve target ที่เป็น `.ts`/`.tsx` ได้โดยตรง

---

## การทดสอบ

```bash
bun test          # 168 tests
bun run typecheck
bun run lint
bun run fmt:check
```

ชุดทดสอบใช้ fake transport/clock/socket แทน hardware ทั้งหมด:
parser ถูกทดสอบด้วย hex fixture, state machine ด้วย fake PC/SC port,
WebSocket ด้วย fake socket และไคลเอนต์ด้วย fake timer

import { createRouter } from "@solidjs/router";
import { History } from "#client/routes/History";
import { Live } from "#client/routes/Live";
import { getClient } from "#client/ws";

const routes = [
  { path: "/", component: Live },
  { path: "/history", component: History },
];

export const Router = createRouter({ routes });

export function App() {
  const client = getClient();

  return (
    <Router>
      {(props) => (
        <div class="app">
          {/*
            The router claims every same-origin anchor, so the skip link opts
            out with target="_self" and lets the browser move focus to <main>.
          */}
          <a class="skip-link" href="#main" target="_self">
            ข้ามไปยังเนื้อหา
          </a>

          <header class="app-header">
            <div class="app-header__inner">
              <a class="brand" href="/">
                <span class="brand__mark" aria-hidden="true">
                  ID
                </span>
                <span class="brand__text">
                  <span class="brand__title">อ่านบัตรประชาชน</span>
                  <span class="brand__sub">เดโมอ่านบัตรประชาชน</span>
                </span>
              </a>

              <nav class="app-nav" aria-label="เมนูหลัก">
                <a href="/">หน้าหลัก</a>
                <a href="/history">ประวัติการอ่าน</a>
              </nav>

              <p class="conn" data-on={String(client.connected())}>
                <span class="conn__dot" aria-hidden="true" />
                {client.connected() ? "เชื่อมต่อแล้ว" : "กำลังเชื่อมต่อ"}
              </p>
            </div>
          </header>

          <main class="app-main" id="main" tabindex="-1">
            {props.children}
          </main>

          <footer class="app-footer">
            ข้อมูลบัตรไม่ถูกจัดเก็บถาวร · เดโมสำหรับสาธิต ไม่ใช่ระบบสำหรับใช้งานจริง
          </footer>
        </div>
      )}
    </Router>
  );
}

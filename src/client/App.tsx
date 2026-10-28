import { createRouter } from "@solidjs/router";
import { History } from "./routes/History";
import { Live } from "./routes/Live";

const routes = [
  { path: "/", component: Live },
  { path: "/history", component: History },
];

export const Router = createRouter({ routes });

export function App() {
  return (
    <Router>
      {(props) => (
        <div class="app">
          <header class="app-header">
            <h1>อ่านบัตรประชาชน</h1>
            <nav class="app-nav">
              <a href="/">หน้าหลัก</a>
              <a href="/history">ประวัติการอ่าน</a>
            </nav>
          </header>
          <main class="app-main">{props.children}</main>
        </div>
      )}
    </Router>
  );
}

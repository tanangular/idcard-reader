/**
 * The live view. It renders the server's state machine and nothing else:
 * no card data is fetched by the browser, and no state is invented here.
 */
import { Match, Switch, createSignal } from "solid-js";
import { CardView } from "#client/components/CardView.tsx";
import { ErrorPanel } from "#client/components/ErrorPanel.tsx";
import { StatusBar } from "#client/components/StatusBar.tsx";
import { Timeline } from "#client/components/Timeline.tsx";
import { getClient } from "#client/ws.ts";

function ConnectingPanel() {
  return (
    <section class="panel idle" aria-labelledby="connecting-title">
      <div class="idle-card idle-card--ghost idle-card--loading" aria-hidden="true">
        <span class="spinner" />
      </div>
      <h2 id="connecting-title">กำลังเชื่อมต่อกับเซิร์ฟเวอร์…</h2>
      <p>ระบบจะลองเชื่อมต่อใหม่ให้อัตโนมัติหากการเชื่อมต่อขาดหาย</p>
    </section>
  );
}

function NoReaderPanel() {
  return (
    <section class="panel idle" aria-labelledby="no-reader-title">
      <div class="idle-card idle-card--ghost idle-card--off" aria-hidden="true" />
      <h2 id="no-reader-title">ไม่พบเครื่องอ่านบัตร</h2>
      <p>เสียบเครื่องอ่านบัตรเข้ากับคอมพิวเตอร์ แล้วรอสักครู่ ระบบจะตรวจพบเอง</p>
      <ol class="hint-list">
        <li>ตรวจสอบว่าสาย USB เสียบแน่นทั้งสองด้าน</li>
        <li>ลองถอดเครื่องอ่านแล้วเสียบใหม่</li>
        <li>ปิดโปรแกรมอื่นที่อาจถือบัตรอยู่</li>
      </ol>
    </section>
  );
}

function WaitingCardPanel() {
  return (
    <section class="panel idle" aria-labelledby="waiting-title">
      <div class="idle-card idle-card--waiting" aria-hidden="true" />
      <h2 id="waiting-title">เสียบบัตรประชาชนเพื่อเริ่มอ่าน</h2>
      <p>ระบบจะอ่านข้อมูลและแสดงรูปถ่ายบนหน้าจอโดยอัตโนมัติ เมื่อถอดบัตร ข้อมูลจะถูกล้างทันที</p>
      <p class="idle__note">ข้อมูลบัตรอยู่ในหน่วยความจำของเซิร์ฟเวอร์บนเครื่องนี้เท่านั้น</p>
    </section>
  );
}

function SyncingPanel() {
  return (
    <section class="panel idle" aria-labelledby="syncing-title">
      <div class="idle-card idle-card--ghost idle-card--loading" aria-hidden="true">
        <span class="spinner" />
      </div>
      <h2 id="syncing-title">กำลังแสดงข้อมูลบัตร…</h2>
      <p>อีกสักครู่ข้อมูลจะปรากฏบนหน้าจอ</p>
    </section>
  );
}

export function Live() {
  const client = getClient();
  const [retrying, setRetrying] = createSignal(false);

  const retry = async (): Promise<void> => {
    if (retrying()) return;
    setRetrying(true);
    try {
      await client.readCard();
    } catch {
      // The status bar already explains a lost connection; card failures
      // arrive as a server push and render through ErrorPanel.
    } finally {
      setRetrying(false);
    }
  };

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1>อ่านบัตรประชาชน</h1>
          <p>เสียบบัตรเพื่ออ่านข้อมูลและรูปถ่าย ระบบจะล้างข้อมูลเมื่อถอดบัตร</p>
        </div>
      </header>

      <StatusBar
        connected={client.connected()}
        phase={client.phase()}
        readers={client.readers()}
        progress={client.progress()}
        error={client.error()}
      />

      <Switch>
        <Match when={!client.connected()}>
          <ConnectingPanel />
        </Match>

        <Match when={client.phase() === "error" ? client.error() : null}>
          {(error) => <ErrorPanel error={error()} busy={retrying()} onRetry={() => void retry()} />}
        </Match>

        <Match when={client.phase() === "ready" ? client.card() : null}>
          {(card) => <CardView card={card()} />}
        </Match>

        <Match when={client.phase() === "reading"}>
          <Timeline progress={client.progress()} />
        </Match>

        <Match when={client.phase() === "no-reader"}>
          <NoReaderPanel />
        </Match>

        <Match when={client.phase() === "waiting-card"}>
          <WaitingCardPanel />
        </Match>

        <Match when={true}>
          <SyncingPanel />
        </Match>
      </Switch>
    </div>
  );
}

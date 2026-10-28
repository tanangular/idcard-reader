/**
 * Audit history. The only data here is the server's PII-free `AuditRow`;
 * the page cannot leak a name, address, birthdate or photo because those
 * fields never reach it.
 */
import { For, Show, createEffect, createSignal, onSettled } from "solid-js";
import type { AuditRow } from "#shared/protocol";
import { formatDateTime, formatDuration, formatHash } from "#client/format";
import { ClientError, getClient } from "#client/ws";

const PAGE_SIZE = 20;

function EmptyHistory(props: {
  loading: boolean;
  loaded: boolean;
  connected: boolean;
  failed: boolean;
}) {
  return (
    <div class="empty">
      <Show
        when={!props.loaded && props.loading}
        fallback={
          <Show
            when={props.loaded}
            fallback={
              <Show
                when={props.connected}
                fallback={
                  <>
                    <h2>กำลังเชื่อมต่อ…</h2>
                    <p>รอการเชื่อมต่อกับเซิร์ฟเวอร์เพื่อโหลดประวัติ</p>
                  </>
                }
              >
                <Show
                  when={props.failed}
                  fallback={
                    <>
                      <h2>ยังไม่มีประวัติการอ่าน</h2>
                      <p>เมื่อมีการอ่านบัตร รายการจะปรากฏที่นี่</p>
                    </>
                  }
                >
                  <h2>โหลดประวัติไม่สำเร็จ</h2>
                  <p>กด "ลองอีกครั้ง" ด้านบนเพื่อโหลดใหม่</p>
                </Show>
              </Show>
            }
          >
            <h2>ยังไม่มีประวัติการอ่าน</h2>
            <p>เมื่อมีการอ่านบัตร รายการจะปรากฏที่นี่</p>
          </Show>
        }
      >
        <p role="status">กำลังโหลดประวัติ…</p>
      </Show>
    </div>
  );
}

function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
      <path
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
        d="M6 10V8a6 6 0 0 1 12 0v2M5 10h14v10H5z"
      />
    </svg>
  );
}

export function History() {
  const client = getClient();

  const [page, setPage] = createSignal(0);
  const [rows, setRows] = createSignal<AuditRow[]>([]);
  const [total, setTotal] = createSignal(0);
  const [loaded, setLoaded] = createSignal(false);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  /** Invalidates an older reply when the page or connection changes. */
  let generation = 0;

  const load = async (target: number): Promise<void> => {
    const mine = ++generation;
    setLoading(true);
    setError(null);

    try {
      const reply = await client.listHistory(PAGE_SIZE, target * PAGE_SIZE);
      if (mine !== generation) return;

      if (!reply.ok) {
        setError(reply.error.message);
        return;
      }

      // Removing rows elsewhere can strand the viewer on an empty last page.
      // Switch first and let the effect fetch it: committing out-of-range
      // rows would flash an empty page before the clamp lands.
      const lastPage = Math.max(0, Math.ceil(reply.total / PAGE_SIZE) - 1);
      if (target > lastPage) {
        setPage(lastPage);
        return;
      }

      setRows(reply.rows);
      setTotal(reply.total);
      setLoaded(true);
    } catch (caught) {
      if (mine !== generation) return;
      setError(
        caught instanceof ClientError && caught.code === "OFFLINE"
          ? "การเชื่อมต่อขาดหาย กำลังเชื่อมต่อใหม่…"
          : "โหลดประวัติไม่สำเร็จ",
      );
    } finally {
      if (mine === generation) setLoading(false);
    }
  };

  // Solid 2 splits effects into a compute phase and an apply phase: the
  // compute phase reads the reactive inputs and returns the page to load
  // (or null while offline); the apply phase performs the request.
  createEffect(
    () => (client.connected() ? page() : null),
    (target) => {
      if (target !== null) void load(target);
    },
  );

  onSettled(() => () => {
    generation += 1;
  });

  const pages = (): number => Math.max(1, Math.ceil(total() / PAGE_SIZE));
  const canPrev = (): boolean => page() > 0;
  const canNext = (): boolean => page() + 1 < pages();

  return (
    <div class="page">
      <header class="page-head">
        <div>
          <h1>ประวัติการอ่านบัตร</h1>
          <p>บันทึกเหตุการณ์บนเครื่องนี้ เฉพาะข้อมูลเมตา ไม่มีข้อมูลส่วนบุคคล</p>
        </div>
        <button
          type="button"
          class="button button--ghost"
          onClick={() => void load(page())}
          disabled={!client.connected() || loading()}
        >
          {loading() ? "กำลังโหลด…" : "รีเฟรช"}
        </button>
      </header>

      <Show when={!client.connected()}>
        <p class="notice" role="status">
          กำลังเชื่อมต่อกับเซิร์ฟเวอร์… ข้อมูลที่แสดงอาจไม่เป็นปัจจุบัน
        </p>
      </Show>

      <Show when={error()}>
        {(message) => (
          <div class="notice notice--error" role="alert">
            <p>{message()}</p>
            <button
              type="button"
              class="button button--small"
              onClick={() => void load(page())}
              disabled={!client.connected() || loading()}
            >
              ลองอีกครั้ง
            </button>
          </div>
        )}
      </Show>

      <div class="table-card">
        <Show
          when={rows().length > 0}
          fallback={
            <EmptyHistory
              loading={loading()}
              loaded={loaded()}
              connected={client.connected()}
              failed={error() !== null}
            />
          }
        >
          <div class="table-scroll" role="region" aria-label="ตารางประวัติการอ่านบัตร" tabindex="0">
            <table>
              <caption class="visually-hidden">รายการอ่านบัตร เรียงจากใหม่ไปเก่า</caption>
              <thead>
                <tr>
                  <th scope="col">เวลา</th>
                  <th scope="col">เครื่องอ่าน</th>
                  <th scope="col">ผล</th>
                  <th scope="col">รหัสข้อผิดพลาด</th>
                  <th scope="col" class="num">
                    ระยะเวลา
                  </th>
                  <th scope="col">รหัสอ้างอิงบัตร</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(row) => (
                    <tr>
                      <td>
                        <time datetime={row.at}>{formatDateTime(row.at)}</time>
                      </td>
                      <td>{row.reader}</td>
                      <td>
                        <span
                          class={row.outcome === "ok" ? "badge badge--ok" : "badge badge--error"}
                        >
                          {row.outcome === "ok" ? "สำเร็จ" : "ผิดพลาด"}
                        </span>
                      </td>
                      <td class="mono">{row.errorCode ?? "—"}</td>
                      <td class="num">{formatDuration(row.durationMs)}</td>
                      <td
                        class="mono"
                        title={
                          row.cidHashShort.length > 0
                            ? "แฮชแบบ salted ของเลขบัตร (8 ตัวแรก)"
                            : undefined
                        }
                      >
                        {formatHash(row.cidHashShort)}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>

          <div class="pager">
            <button
              type="button"
              class="button button--ghost"
              onClick={() => setPage((current) => Math.max(0, current - 1))}
              disabled={!canPrev() || loading()}
            >
              ก่อนหน้า
            </button>
            <p class="pager__status" role="status">
              หน้า {page() + 1} จาก {pages()} · {total()} รายการ
            </p>
            <button
              type="button"
              class="button button--ghost"
              onClick={() => setPage((current) => Math.min(pages() - 1, current + 1))}
              disabled={!canNext() || loading()}
            >
              ถัดไป
            </button>
          </div>
        </Show>
      </div>

      <aside class="privacy-note">
        <LockIcon />
        <p>
          <strong>ไม่เก็บข้อมูลส่วนบุคคล</strong> หน้านี้แสดงเฉพาะเวลา เครื่องอ่าน ผลลัพธ์ ระยะเวลา
          และรหัสอ้างอิงแบบสั้น ซึ่งเป็นแฮชแบบ salted ของเลขบัตร ไม่มีเลขบัตร ชื่อ ที่อยู่ วันเกิด หรือรูปถ่าย
        </p>
      </aside>
    </div>
  );
}

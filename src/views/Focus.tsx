import { useEffect, useRef, useState } from "react";

type Mode = "focus" | "short" | "long";

const MODE_MINUTES: Record<Mode, number> = { focus: 25, short: 5, long: 15 };
const MODE_LABEL: Record<Mode, string> = { focus: "专注", short: "短休息", long: "长休息" };
const MODE_HINT: Record<Mode, string> = {
  focus: "沉浸式处理手头工作：审查合同、起草文书、检索法规……",
  short: "离开屏幕，起身活动，喝口水。",
  long: "连续专注几轮后，给自己一段完整休息。",
};
const LS_POMOS = "workbench:pomos";

function fmt(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export default function Focus() {
  const [mode, setMode] = useState<Mode>("focus");
  const [total, setTotal] = useState(MODE_MINUTES.focus * 60);
  const [left, setLeft] = useState(MODE_MINUTES.focus * 60);
  const [running, setRunning] = useState(false);
  const [task, setTask] = useState("");
  const [pomos, setPomos] = useState<number>(() => {
    try {
      return Number(localStorage.getItem(LS_POMOS)) || 0;
    } catch {
      return 0;
    }
  });
  const doneRef = useRef(false);

  function switchMode(m: Mode) {
    doneRef.current = false;
    setRunning(false);
    setMode(m);
    setTotal(MODE_MINUTES[m] * 60);
    setLeft(MODE_MINUTES[m] * 60);
  }

  function notify(title: string, body: string) {
    try {
      if (!("Notification" in window)) return;
      if (Notification.permission === "granted") {
        new Notification(title, { body });
      } else if (Notification.permission !== "denied") {
        void Notification.requestPermission();
      }
    } catch {
      /* ignore */
    }
  }

  // 倒计时
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setLeft((l) => l - 1), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  // 完成回调
  useEffect(() => {
    if (left > 0 || doneRef.current) return;
    doneRef.current = true;
    setRunning(false);
    if (mode === "focus") {
      notify("律政工作台 · 专注完成", "一个番茄结束，休息一下吧 🍅");
      setPomos((p) => {
        const n = p + 1;
        try {
          localStorage.setItem(LS_POMOS, String(n));
        } catch {
          /* ignore */
        }
        return n;
      });
      switchMode("short");
    } else {
      notify("律政工作台 · 休息结束", "开始新一轮专注，继续加油。");
      switchMode("focus");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [left]);

  const R = 88;
  const C = 2 * Math.PI * R;
  const progress = total > 0 ? Math.max(left / total, 0) : 0;

  return (
    <div className="focus-page">
      {/* 模式切换 */}
      <div className="card">
        <div className="mode-chips">
          {(Object.keys(MODE_MINUTES) as Mode[]).map((m) => (
            <button
              key={m}
              className={`chip ${mode === m ? "chip-active" : ""}`}
              onClick={() => switchMode(m)}
            >
              {MODE_LABEL[m]} {MODE_MINUTES[m]}′
            </button>
          ))}
        </div>
      </div>

      {/* 计时环 */}
      <div className="card focus-ring-card">
        <div className="focus-ring-wrap">
          <svg width="230" height="230" viewBox="0 0 230 230">
            <circle cx="115" cy="115" r={R} fill="none" stroke="var(--border)" strokeWidth="12" />
            <circle
              cx="115"
              cy="115"
              r={R}
              fill="none"
              stroke="var(--brand)"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray={C}
              strokeDashoffset={C * (1 - progress)}
              transform="rotate(-90 115 115)"
              style={{ transition: "stroke-dashoffset 1s linear" }}
            />
          </svg>
          <div className="focus-ring-center">
            <span className="focus-mode">{MODE_LABEL[mode]}</span>
            <span className="focus-time">{fmt(Math.max(left, 0))}</span>
            {task.trim() && <span className="focus-task">{task.trim()}</span>}
          </div>
        </div>

        <div className="focus-task-input">
          <input
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="本轮专注任务，如：审查合作协议（可选）"
            disabled={running}
          />
        </div>

        <div className="focus-controls">
          <button className="primary" onClick={() => setRunning((r) => !r)}>
            {running ? "暂停" : left < total ? "继续" : "开始专注"}
          </button>
          <button className="ghost-btn" onClick={() => { doneRef.current = false; setRunning(false); setLeft(total); }}>
            重置
          </button>
        </div>

        <p className="muted hint">{MODE_HINT[mode]}</p>
        <p className="muted">
          今日完成 <b>{pomos}</b> 个番茄 🍅
          {pomos > 0 && " · 记得每 4 个番茄安排一次长休息"}
        </p>
      </div>
    </div>
  );
}

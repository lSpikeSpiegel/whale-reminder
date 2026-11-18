import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { Menu, type MenuItemOptions } from "@tauri-apps/api/menu";
import { Pet } from "./pet/Pet";
import { Panel } from "./panel/Panel";
import { Bubble } from "./panel/Bubble";
import { PickOverlay } from "./scan/PickOverlay";
import { ScanOverlay } from "./scan/ScanOverlay";
import { usePetBehavior } from "./pet/usePetBehavior";
import { LIVE2D_ENABLED } from "./live2d/availability";
import {
  ACTIVITY_LABEL,
  loadPetMeta,
  type PetActivity,
  type PetMeta,
  type PetStyle,
} from "./pet/poses";
import "./App.css";

const appWindow = getCurrentWindow();

/** 贴边方向，与 Rust 侧 Edge 序列化后的字符串一致 */
type Edge = "left" | "right" | "top" | "bottom";

/** 按下与抬起的位置差不超过这个值（CSS px）就算"没动"，判定为单击 */
const CLICK_TOLERANCE = 3;
/** 两次点击间隔小于这个值就算双击 */
const DOUBLE_CLICK_MS = 280;
/** 立绘上半部分算头部，点这里触发摸头。
 *  Q 版是大头娃娃，头占将近一半；写实是 9 头身，头只占上面三成。 */
const HEAD_RATIO: Record<PetStyle, number> = { chibi: 0.46, real: 0.3 };
/** 拖拽停手多久算松手（指针事件丢失时的兜底） */
const DRAG_SETTLE_MS = 420;
/** 松手速度超过这个值（物理像素/毫秒）就当「甩出去」，不再吸附贴边 */
const THROW_SPEED = 0.35;
/** 速度采样超过这么久就算过期，松手时当 0 处理 */
const VELOCITY_FRESH_MS = 140;

/** 开发期数字键预览各动作 */
const DEV_KEYS: Record<string, PetActivity> = {
  "1": "idle",
  "2": "pat",
  "3": "poke",
  "4": "happy",
  "5": "think",
  "6": "slack",
  "7": "daydream",
  "8": "bored",
  "9": "doze",
  "0": "sleep",
  q: "work",
  w: "eat",
  e: "peek",
};

/**
 * 右键菜单「动作」里的两组动作。
 *
 * 覆盖全部 18 个 `PetActivity`，**只少了 `pat` / `poke`**：那两个在菜单顶部单独列，
 * 走的是真实交互链路（连摸三下会得意、连戳五下会生气），和这里「直接演一遍」不同。
 *
 * 托盘菜单在 Rust 侧（`tray.rs`）另有一份，改这里记得同步那边。
 */
const MENU_STATES: PetActivity[] = [
  "idle",
  "react",
  "think",
  "slack",
  "daydream",
  "bored",
  "drag",
  "peek",
  "doze",
  "sleep",
  "work",
  "eat",
];
/** 情绪类，一眼能看出差别的四个 */
const MENU_MOODS: PetActivity[] = ["happy", "angry", "smug", "sad"];

interface Point {
  x: number;
  y: number;
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// 临时：把网页里的异常转发到终端（WebView2 的 console 在 tauri dev 里看不见）
if (import.meta.env.DEV) {
  window.addEventListener("error", (event) => {
    void invoke("web_log", { message: `[error] ${event.message} @ ${event.filename}:${event.lineno}` }).catch(() => {});
  });
  window.addEventListener("unhandledrejection", (event) => {
    void invoke("web_log", { message: `[reject] ${String(event.reason)}` }).catch(() => {});
  });
}

function PetView() {
  const [meta, setMeta] = useState<PetMeta | null>(null);
  /** 立绘风格，由设置页决定；默认 Q 版，读不到设置也不影响显示 */
  const [style, setStyle] = useState<PetStyle>("chibi");
  /** 设置页开了 Live2D 没有 */
  const [live2d, setLive2d] = useState(false);
  /** 动态立绘加载失败的原因；非 null 就一直用静态图，不再重试 */
  const [liveFailed, setLiveFailed] = useState<string | null>(null);
  const [dock, setDock] = useState<Edge | null>(null);
  const [tilt, setTilt] = useState(0);
  const [land, setLand] = useState(0);

  const behavior = usePetBehavior(Boolean(dock));
  const { activity, burst } = behavior;
  /**
   * 真的用动态立绘吗。窗口尺寸和热区比例都跟着它走，所以只算一处。
   *
   * `LIVE2D_ENABLED` 关掉时这里恒为 false：模型本体不入库，发布版根本没有素材，
   * 但用户上次在开发版里开过的话 `settings.json` 里还留着 `pet_live2d: true`，
   * 不拦就是「每次启动都去加载一次必失败的文件」。
   */
  const live = LIVE2D_ENABLED && style === "real" && live2d && liveFailed === null;

  /** 按下时的屏幕坐标；null 表示当前没有按下 */
  const pressOrigin = useRef<Point | null>(null);
  /** 本次按下是否已经交棒给系统拖拽 */
  const dragging = useRef(false);
  /** 上一次单击的时间戳，用来判定双击 */
  const lastClickAt = useRef(0);
  /** 是否已经缩到屏幕外只露一半 */
  const peeked = useRef(false);
  /** 拖拽速度采样 */
  const lastMove = useRef<{ x: number; y: number; at: number } | null>(null);
  /** 松手瞬间的速度（物理像素/毫秒），决定甩不甩、甩多远 */
  const velocity = useRef({ vx: 0, vy: 0, at: 0 });
  const settleTimer = useRef(0);
  const behaviorRef = useRef(behavior);
  behaviorRef.current = behavior;

  /** 结束一次拖拽：甩出去、或者落地回弹 + 吸附贴边 */
  const endDrag = useCallback(() => {
    if (!dragging.current) return;
    dragging.current = false;
    pressOrigin.current = null;
    window.clearTimeout(settleTimer.current);
    lastMove.current = null;
    setTilt(0);
    setLand((value) => value + 1);

    // 松手速度够快就是「甩出去」：交给 Rust 做滑行和反弹，这里不再吸附贴边，
    // 否则两套逻辑会抢同一个坐标
    const now = performance.now();
    const { vx, vy, at } = velocity.current;
    velocity.current = { vx: 0, vy: 0, at: 0 };
    const speed = Math.hypot(vx, vy);
    if (now - at < VELOCITY_FRESH_MS && speed > THROW_SPEED) {
      setDock(null);
      behaviorRef.current.play("drag", 1_600);
      invoke("pet_throw", { vx, vy }).catch((err) => {
        console.error("[pet] 甩出去失败", err);
        behaviorRef.current.play("idle", 2_000);
      });
      return;
    }

    invoke<Edge | null>("snap_pet")
      .then((edge) => {
        setDock(edge);
        if (edge) {
          behaviorRef.current.play("peek", 4_000);
          behaviorRef.current.say("就靠这儿了～");
        } else {
          behaviorRef.current.play("idle", 3_000);
        }
      })
      .catch((err) => {
        console.error("[pet] 贴边失败", err);
        behaviorRef.current.play("idle", 3_000);
      });
  }, []);

  useEffect(() => {
    invoke<{ pet_style: PetStyle; pet_live2d: boolean }>("get_settings")
      .then((view) => {
        setStyle(view.pet_style);
        setLive2d(view.pet_live2d);
        void invoke("web_log", {
          message: `[pet] 设置：style=${view.pet_style} live=${view.pet_live2d}`,
        }).catch(() => {});
      })
      .catch((err) => console.error("[pet] 读取立绘风格失败", err));
  }, []);

  // 设置页开关动态立绘：重新给一次机会（之前失败过也重试）
  useEffect(() => {
    const pending = listen<boolean>("pet://live", (event) => {
      setLive2d(event.payload);
      setLiveFailed(null);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 设置页换立绘：面板推事件过来，桌宠立刻换素材
  useEffect(() => {
    const pending = listen<string>("pet://style", (event) => {
      setStyle(event.payload as PetStyle);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 换风格就换一份 meta（两套素材的姿势表不一样）
  useEffect(() => {
    let alive = true;
    loadPetMeta(style)
      .then((next) => {
        if (alive) setMeta(next);
      })
      .catch((err) => console.error("[pet] 元数据加载失败", err));
    return () => {
      alive = false;
    };
  }, [style]);

  // 启动时问一下上次是不是贴着边
  useEffect(() => {
    invoke<Edge | null>("get_dock")
      .then((edge) => setDock(edge))
      .catch(() => {
        /* 非 Tauri 环境下没有这个命令 */
      });
  }, []);

  // Rust 侧主动吸附（托盘菜单「贴边」）时同步前端状态
  useEffect(() => {
    const pending = listen<{ edge: Edge | null }>("pet://dock", (event) => {
      peeked.current = false;
      setDock(event.payload.edge);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 提醒触发：坐下来干活，6 秒后回到自己的节奏
  useEffect(() => {
    const pending = listen("reminder://fire", () => {
      behaviorRef.current.play("work", 6_000);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 甩出去之后落地：撞过边就委屈一下，再试一次吸附（可能正好停在边上）
  useEffect(() => {
    const pending = listen<boolean>("pet://landed", (event) => {
      if (event.payload) {
        behaviorRef.current.sulk();
      } else {
        behaviorRef.current.play("idle", 1_600);
      }
      invoke<Edge | null>("snap_pet")
        .then((edge) => {
          if (edge) {
            setDock(edge);
            behaviorRef.current.play("peek", 3_000);
          }
        })
        .catch(() => {
          /* 贴边失败不影响落地表现 */
        });
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 托盘 / 右键菜单下发的动作
  useEffect(() => {
    const pending = listen<string>("pet://action", (event) => {
      const action = event.payload;
      if (action === "wake") {
        behaviorRef.current.wake();
        return;
      }
      // 托盘菜单的动作清单在 Rust 侧（tray.rs），和这边各写一份；
      // 拼错了别让她用一张 undefined 的立绘——直接忽略并留条日志
      if (!(action in ACTIVITY_LABEL)) {
        console.error("[pet] 未知动作，已忽略：", action);
        return;
      }
      behaviorRef.current.play(action as PetActivity, 5_200);
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 把文件拖到她身上 → 吃东西（文件不会被删除，只是互动彩蛋）
  useEffect(() => {
    const pending = appWindow.onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      behaviorRef.current.play("eat", 3_400);
      behaviorRef.current.say("唔姆唔姆…谢谢投喂！");
    });
    return () => {
      void pending.then((unlisten) => unlisten());
    };
  }, []);

  // 拖拽倾斜：从窗口位移算速度，方向跟手，松手回正
  useEffect(() => {
    const pending = appWindow.onMoved(({ payload }) => {
      if (!dragging.current) return;
      const now = performance.now();
      const previous = lastMove.current;
      lastMove.current = { x: payload.x, y: payload.y, at: now };
      if (previous) {
        const dt = Math.max(now - previous.at, 16);
        const vx = (payload.x - previous.x) / dt;
        const vy = (payload.y - previous.y) / dt;
        // 记下瞬时速度：松手时用它决定要不要甩出去
        velocity.current = { vx, vy, at: now };
        setTilt(Math.max(-8, Math.min(8, -vx * 9)));
      }
      // 指针事件有可能在 startDragging 之后丢失，用「停手」兜底收尾
      window.clearTimeout(settleTimer.current);
      settleTimer.current = window.setTimeout(endDrag, DRAG_SETTLE_MS);
    });
    return () => {
      window.clearTimeout(settleTimer.current);
      void pending.then((unlisten) => unlisten());
    };
    // endDrag 用 ref 访问最新闭包，这里只挂一次监听
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 贴着边睡熟以后，慢慢缩到屏幕外只露一半；鼠标过来再滑回去。
  // 只在深睡时做：打瞌睡会时不时抬头，探头收头会抖个不停。
  useEffect(() => {
    if (!dock) {
      peeked.current = false;
      return;
    }
    if (dock === "top" || dock === "bottom") return;
    if (activity !== "sleep") return;

    const timer = window.setTimeout(() => {
      peeked.current = true;
      void invoke("pet_peek", { peekOut: true }).catch(() => {});
    }, 20_000);
    return () => window.clearTimeout(timer);
  }, [dock, activity]);

  useEffect(() => () => window.clearTimeout(settleTimer.current), []);

  // 贴边时侧身朝内：左边贴墙要朝右看，右边贴墙朝左看
  const flip = dock === "left" ? -1 : 1;
  const docked = Boolean(dock);

  const handlePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 只记下起点，不动状态、也不立刻开始拖拽
    pressOrigin.current = { x: e.screenX, y: e.screenY };
    dragging.current = false;
    behaviorRef.current.touch();
    // 抓住指针：光标冲出这个小窗口后，move / up 事件仍然能收到
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const handlePointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const origin = pressOrigin.current;
    if (!origin || dragging.current) return;
    // 左键已经松开了。系统接管拖拽后我们可能收不到 up 事件，
    // 这时候再启动一次拖拽就会把窗口甩到莫名其妙的地方。
    if ((e.buttons & 1) === 0) {
      pressOrigin.current = null;
      return;
    }
    // 越过容差 = 这是拖拽，把窗口交给系统跟随光标
    if (distance(origin, { x: e.screenX, y: e.screenY }) <= CLICK_TOLERANCE) return;
    dragging.current = true;
    behaviorRef.current.play("drag", 60_000);
    appWindow.startDragging().catch((err) => {
      console.error("[pet] 拖拽启动失败", err);
      dragging.current = false;
    });
  }, []);

  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const origin = pressOrigin.current;
      pressOrigin.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      if (!origin) return;

      // 拖拽过：交给 endDrag 收尾（可能已经由兜底定时器收过了）
      if (dragging.current) {
        endDrag();
        return;
      }
      if (distance(origin, { x: e.screenX, y: e.screenY }) > CLICK_TOLERANCE) return;

      // 双击打开面板，单击摸头 / 戳一戳。
      // 单击动作立刻执行，不等双击窗口——摸头必须跟手。
      const now = Date.now();
      if (now - lastClickAt.current < DOUBLE_CLICK_MS) {
        lastClickAt.current = 0;
        invoke("open_panel").catch((err) => console.error("[pet] 打开面板失败", err));
        return;
      }
      lastClickAt.current = now;

      const rect = e.currentTarget.getBoundingClientRect();
      const ratio = (e.clientY - rect.top) / rect.height;
      // 动态立绘那个 Q 版模型头占得更多（窗口也换成了宽扁的），沿用写实版的三成
      // 会把脸的下半截判成「戳」
      if (ratio <= (live ? HEAD_RATIO.chibi : HEAD_RATIO[style])) {
        behaviorRef.current.pat();
      } else {
        behaviorRef.current.poke();
      }
    },
    [endDrag, style, live],
  );

  const handlePointerCancel = useCallback(() => {
    pressOrigin.current = null;
    if (dragging.current) endDrag();
  }, [endDrag]);

  /** 动态立绘起不来就退回静态图，别让桌宠开天窗 */
  const handleLiveFail = useCallback((reason: string) => {
    setLiveFailed(reason);
  }, []);

  const handleEnter = useCallback(() => {
    if (peeked.current) {
      peeked.current = false;
      void invoke("pet_peek", { peekOut: false }).catch(() => {});
    }
    const current = behaviorRef.current.activity;
    if (current === "idle" || current === "peek") {
      behaviorRef.current.play("react", 2_200);
    }
  }, []);

  const handleContextMenu = useCallback(
    async (e: ReactMouseEvent<HTMLDivElement>) => {
      e.preventDefault();

      /** 一个「直接演一遍」的动作项。5.2 秒和状态机自己演一次的时长一致 */
      const act = (activity: PetActivity): MenuItemOptions => ({
        id: `act:${activity}`,
        text: ACTIVITY_LABEL[activity],
        action: () => behaviorRef.current.play(activity, 5_200),
      });

      try {
        const menu = await Menu.new({
          items: [
            { id: "pat", text: "摸摸头", action: () => behaviorRef.current.pat() },
            { id: "poke", text: "戳一戳", action: () => behaviorRef.current.poke() },
            { id: "wake", text: "叫醒她", action: () => behaviorRef.current.wake() },
            { item: "Separator" },
            {
              text: "动作",
              items: [
                ...MENU_STATES.map(act),
                { item: "Separator" },
                ...MENU_MOODS.map(act),
              ],
            },
            {
              text: "贴边",
              items: (["left", "right", "top", "bottom"] as Edge[]).map((edge) => ({
                id: `dock:${edge}`,
                text:
                  edge === "left"
                    ? "贴左边"
                    : edge === "right"
                      ? "贴右边"
                      : edge === "top"
                        ? "贴上面"
                        : "贴下面",
                action: () => void invoke("dock_pet", { edge }).catch(() => {}),
              })),
            },
            { id: "undock", text: "取消贴边", action: () => void invoke("dock_pet", { edge: null }).catch(() => {}) },
            {
              id: "monitor",
              text: "移到下一块显示器",
              action: () =>
                void invoke<number | null>("pet_next_monitor")
                  .then((index) => {
                    if (index === null) {
                      behaviorRef.current.say("就一块屏幕呀");
                      return;
                    }
                    setDock(null);
                    behaviorRef.current.play("happy", 2_400);
                  })
                  .catch((err) => console.error("[pet] 换屏失败", err)),
            },
            {
              id: "home",
              text: "叫回来",
              action: () => {
                setDock(null);
                void invoke("pet_home").catch((err) => console.error("[pet] 叫回来失败", err));
                behaviorRef.current.play("happy", 2_400);
              },
            },
            { item: "Separator" },
            {
              id: "panel",
              text: "打开待办面板",
              action: () => void invoke("open_panel").catch(() => {}),
            },
            { id: "hide", text: "隐藏桌宠", action: () => void appWindow.hide().catch(() => {}) },
          ],
        });
        await menu.popup(new LogicalPosition(e.clientX, e.clientY), appWindow);
      } catch (err) {
        console.error("[pet] 右键菜单打开失败", err);
      }
    },
    [],
  );

  // 开发期预览
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const onKey = (e: KeyboardEvent) => {
      const next = DEV_KEYS[e.key];
      if (next) behaviorRef.current.play(next, 6_000);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const className = useMemo(
    () => `stage${docked ? " stage--docked" : ""}${activity === "drag" ? " stage--drag" : ""}`,
    [docked, activity],
  );

  return (
    <div className={className} onContextMenu={handleContextMenu}>
      <div
        className="pet-hit"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
        onMouseEnter={handleEnter}
      >
        <Pet
          activity={activity}
          meta={meta}
          style={style}
          live={live}
          onLiveFail={handleLiveFail}
          tilt={tilt}
          flip={flip}
          land={land}
          burst={burst}
        />
      </div>
    </div>
  );
}

function App() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "panel") return <Panel />;
  if (view === "bubble") return <Bubble />;
  if (view === "scan") return <ScanOverlay />;
  if (view === "pick") return <PickOverlay />;
  return <PetView />;
}

export default App;

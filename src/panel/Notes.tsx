import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { copyText } from "../ui/clipboard";
import { formatClock } from "../ui/date";
import type { Note, TagView } from "./types";
import "./notes.css";

interface Props {
  /** 内容变化后让面板重新量高度 */
  onLayout: () => void;
  /**
   * 从搜索页跳过来时要找的那条备忘。
   *
   * 备忘页没有「选中」这个概念（卡片是整块可点即复制），所以这里只做两件事：
   * 滚到它，然后点亮一下。闪完就归 null，页面的行为跟平常一模一样。
   */
  focusId?: string | null;
}

/**
 * 多长的备忘才折起来。
 *
 * 按字数估，不去量 DOM：量的话要等一次重排，`fit()` 会量到折行前后的中间态，
 * 窗口高度得来回抖两下。估错了最多是「差一行才出展开」，不影响用。
 */
const FOLD_OVER = 90;
const FOLD_LINES = 4;

/** 从搜索页跳过来时，目标那条点亮多久 */
const FLASH_MS = 1600;

const isLong = (body: string) => body.length > FOLD_OVER || body.split("\n").length > FOLD_LINES;

/* ---------------------------------------------------------------- 标签选择 */

interface PickerProps {
  tags: TagView[];
  selected: string[];
  onToggle: (id: string) => void;
  /** 建完返回新标签 id（同名会返回已有的那个），失败返回 null */
  onCreate: (name: string) => Promise<string | null>;
  /** 只有写新备忘那张卡给「管理」入口，编辑态不给——全局操作有一个入口就够了 */
  onManage?: () => void;
  managing?: boolean;
}

/**
 * 一排标签胶囊：点一下关联，再点一下取消。
 *
 * 「+ 标签」就地变成输入框，Enter / 失焦提交、Esc 取消。建完自动选中——
 * 用户刚敲完一个标签名，肯定是要用它。
 */
function TagPicker({ tags, selected, onToggle, onCreate, onManage, managing = false }: PickerProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  /** Enter 和失焦会连着触发两次，用这个挡住第二次 */
  const busy = useRef(false);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  const submit = async () => {
    if (busy.current) return;
    busy.current = true;
    const value = name.trim();
    setCreating(false);
    setName("");
    try {
      if (value !== "") {
        const id = await onCreate(value);
        if (id !== null && !selected.includes(id)) onToggle(id);
      }
    } finally {
      busy.current = false;
    }
  };

  return (
    <div className="tagpick">
      {tags.map((tag) => (
        <button
          key={tag.id}
          type="button"
          className={`chip chip--tag${selected.includes(tag.id) ? " chip--on" : ""}`}
          onClick={() => onToggle(tag.id)}
          aria-pressed={selected.includes(tag.id)}
        >
          #{tag.name}
        </button>
      ))}

      {creating ? (
        <input
          ref={inputRef}
          className="tagpick__input"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void submit();
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setName("");
              setCreating(false);
            }
          }}
          onBlur={() => void submit()}
          placeholder="标签名"
          maxLength={12}
          aria-label="新标签名"
        />
      ) : (
        <button type="button" className="chip chip--dashed" onClick={() => setCreating(true)}>
          + 标签
        </button>
      )}

      {onManage !== undefined && tags.length > 0 && (
        <button
          type="button"
          className={`tagpick__manage${managing ? " tagpick__manage--on" : ""}`}
          onClick={onManage}
          aria-expanded={managing}
        >
          {managing ? "完成" : "管理"}
        </button>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 标签管理 */

/** 展开在写备忘那张卡里的标签管理：一行一个，删掉标签备忘本身还在 */
function TagManager({
  tags,
  onDelete,
}: {
  tags: TagView[];
  onDelete: (id: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const timer = useRef(0);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
    },
    [],
  );

  const remove = (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setConfirming(null), 3500);
      return;
    }
    window.clearTimeout(timer.current);
    setConfirming(null);
    void onDelete(id);
  };

  return (
    <div className="tagmgr">
      <div className="tagmgr__head">
        <span className="tagmgr__title">管理标签</span>
        <span className="tagmgr__hint">删掉后，备忘本身还在</span>
      </div>

      {tags.length === 0 ? (
        <p className="tagmgr__empty">还没有标签，点上面的「+ 标签」建一个</p>
      ) : (
        <ul className="tagmgr__list">
          {tags.map((tag) => (
            <li key={tag.id} className="tagmgr__row">
              <span className="tagmgr__name">#{tag.name}</span>
              <span className="tagmgr__count">{tag.note_count} 条</span>
              <button
                type="button"
                className={`tagmgr__del${confirming === tag.id ? " tagmgr__del--armed" : ""}`}
                onClick={() => remove(tag.id)}
              >
                {confirming === tag.id ? "确定删除？" : "删除"}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- 页面 */

/**
 * 备忘录：上面写、下面列，标签贯穿两头。
 *
 * 和待办页的区别是「不进调度」——这里只存文字，不设时间也不提醒。
 * 排序交给后端（置顶在前、最近改过的在前），筛选也交给后端（按标签 id 走 SQL），
 * 前端只管把列表摆出来。
 */
export function Notes({ onLayout, focusId = null }: Props) {
  const [notes, setNotes] = useState<Note[]>([]);
  const [tags, setTags] = useState<TagView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /** 正在看的标签，null 是全部 */
  const [filter, setFilter] = useState<string | null>(null);

  /** 正在写的新备忘 */
  const [draft, setDraft] = useState("");
  /**
   * 新备忘要挂的标签。`null` 表示「还没动过」——这时跟着当前筛选走：
   * 在「#工作」下写东西，默认就是工作备忘。用户一旦点过标签，就以他点的为准。
   */
  const [draftTags, setDraftTags] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [managing, setManaging] = useState(false);

  /** 正在编辑的备忘 id 和它的草稿；null 表示没在编辑 */
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editTags, setEditTags] = useState<string[]>([]);

  /** 展开了的备忘 id。长内容默认折五行，点「展开」才铺开 */
  const [opened, setOpened] = useState<string[]>([]);

  /** 删除要点两下：第一次变成「确定删除？」，3.5 秒不点自己退回去 */
  const [confirming, setConfirming] = useState<string | null>(null);

  /** 刚复制过的备忘 id，1.6 秒后自己消失（时间那一格会临时变成「已复制」） */
  const [copied, setCopied] = useState<string | null>(null);

  /** 从搜索页跳过来时正点亮的那条，闪完归 null */
  const [flashNote, setFlashNote] = useState<string | null>(null);

  const confirmTimer = useRef(0);
  const copyTimer = useRef(0);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** 已经点亮过一次的 id：列表重新加载时别再闪一遍 */
  const flashedRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [list, tagList] = await Promise.all([
        invoke<Note[]>("list_notes", { filter: filter === null ? null : { tag_id: filter } }),
        invoke<TagView[]>("list_tags"),
      ]);
      setNotes(list);
      setTags(tagList);
      setError(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * 滚到搜索页选中的那条并点亮一下。
   *
   * 依赖 `notes`：数据是全量拉的，第一次渲染时目标可能还没到，等它到齐再滚才有意义。
   * `flashedRef` 兜住「列表又变了」的情况——编辑一条备忘会让 notes 换新数组，
   * 没有这道闸就会每改一次闪一次。
   */
  useEffect(() => {
    if (focusId === null || flashedRef.current === focusId) return;

    const node = listRef.current?.querySelector<HTMLElement>(`[data-note-id="${focusId}"]`);
    if (node == null) return;

    flashedRef.current = focusId;
    node.scrollIntoView({ block: "nearest" });
    setFlashNote(focusId);
    const timer = window.setTimeout(() => setFlashNote(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [focusId, notes]);

  useEffect(() => {
    onLayout();
  }, [onLayout, notes, tags, error, loading, editing, opened, confirming, managing, filter, draftTags]);

  // 编辑框是条件渲染出来的，等它挂上再去抢焦点
  useEffect(() => {
    if (editing !== null) editRef.current?.focus();
  }, [editing]);

  useEffect(
    () => () => {
      window.clearTimeout(confirmTimer.current);
      window.clearTimeout(copyTimer.current);
    },
    [],
  );

  /**
   * 点卡片就复制正文。
   *
   * 复制只给一次短反馈（时间那一格变「已复制」+ 卡片描边亮一下），不弹 toast：
   * 面板里没有全局提示位，而浮层又要 portal，为一句「已复制」不值得。
   */
  const copyNote = async (note: Note) => {
    const done = await copyText(note.body);
    if (!done) {
      setError("复制失败，选中文字再按 Ctrl + C");
      return;
    }
    setError(null);
    setCopied(note.id);
    window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(null), 1600);
  };

  /** 没动过就跟着筛选走，动过就听用户的 */
  const selectedDraft = draftTags ?? (filter === null ? [] : [filter]);

  const toggleDraftTag = (id: string) => {
    setDraftTags(
      selectedDraft.includes(id) ? selectedDraft.filter((item) => item !== id) : [...selectedDraft, id],
    );
  };

  const createTag = async (name: string): Promise<string | null> => {
    try {
      const created = await invoke<TagView>("create_tag", { name });
      // 重新拉一遍而不是本地拼：顺序由后端定（按名字排），两边各排一次迟早不一致
      await load();
      return created.id;
    } catch (err) {
      setError(String(err));
      return null;
    }
  };

  const removeTag = async (id: string) => {
    try {
      await invoke("delete_tag", { id });
      // 正在按它筛选、或者草稿里选了它，都得跟着收拾干净
      if (filter === id) setFilter(null);
      setDraftTags((prev) => (prev === null ? prev : prev.filter((item) => item !== id)));
      setEditTags((prev) => prev.filter((item) => item !== id));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  /** 记一条新的 */
  const add = async () => {
    const body = draft.trim();
    if (body === "" || saving) return;
    setSaving(true);
    try {
      await invoke<Note>("create_note", { input: { body, tags: selectedDraft } });
      setDraft("");
      setDraftTags(null);
      await load();
      draftRef.current?.focus();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  };

  /** 置顶 / 取消置顶。后端不会因为这一步改 updated_at，顺序只在两组之间变 */
  const togglePin = async (note: Note) => {
    try {
      await invoke<Note>("update_note", { id: note.id, patch: { pinned: !note.pinned } });
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const startEdit = (note: Note) => {
    setConfirming(null);
    setEditing(note.id);
    setEditText(note.body);
    setEditTags(note.tags.map((tag) => tag.id));
  };

  const cancelEdit = () => {
    setEditing(null);
    setEditText("");
    setEditTags([]);
  };

  const saveEdit = async () => {
    if (editing === null) return;
    const body = editText.trim();
    if (body === "") {
      setError("备忘不能是空的，不想留就删掉它");
      return;
    }
    try {
      await invoke<Note>("update_note", { id: editing, patch: { body, tags: editTags } });
      cancelEdit();
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const remove = async (id: string) => {
    if (confirming !== id) {
      setConfirming(id);
      window.clearTimeout(confirmTimer.current);
      confirmTimer.current = window.setTimeout(() => setConfirming(null), 3500);
      return;
    }
    window.clearTimeout(confirmTimer.current);
    setConfirming(null);
    try {
      await invoke("delete_note", { id });
      setOpened((prev) => prev.filter((item) => item !== id));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const toggleOpen = (id: string) => {
    setOpened((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
  };

  return (
    <>
      <div className="notes__composer">
        <textarea
          ref={draftRef}
          className="notes__input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter 换行，Ctrl/Cmd + Enter 才提交——这里写的是多行文字，
            // 回车直接提交会把「列个清单」变成「存一条」。
            if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              void add();
            }
          }}
          placeholder="记点什么，免得忘…"
          aria-label="新的备忘"
          spellCheck={false}
          autoFocus
        />

        <TagPicker
          tags={tags}
          selected={selectedDraft}
          onToggle={toggleDraftTag}
          onCreate={createTag}
          onManage={() => setManaging((prev) => !prev)}
          managing={managing}
        />

        {managing && <TagManager tags={tags} onDelete={removeTag} />}

        <div className="notes__bar">
          <span className="notes__hint">Ctrl + Enter 记下</span>
          <button
            type="button"
            className="ui-btn ui-btn--primary notes__add"
            onClick={() => void add()}
            disabled={saving || draft.trim() === ""}
          >
            {saving ? "记下中" : "记下"}
          </button>
        </div>
      </div>

      {error !== null && <div className="panel__error">{error}</div>}

      {tags.length > 0 && (
        <div className="notes__filters" role="group" aria-label="按标签筛选">
          <button
            type="button"
            className={`chip chip--sm${filter === null ? " chip--on" : ""}`}
            onClick={() => setFilter(null)}
            aria-pressed={filter === null}
          >
            全部
          </button>
          {tags.map((tag) => (
            <button
              key={tag.id}
              type="button"
              className={`chip chip--sm${filter === tag.id ? " chip--on" : ""}`}
              onClick={() => setFilter(filter === tag.id ? null : tag.id)}
              aria-pressed={filter === tag.id}
            >
              #{tag.name}
            </button>
          ))}
        </div>
      )}

      <div className="list-head">
        <span className="list-head__title">备忘</span>
        <span className="list-head__count">{notes.length}</span>
        {filter !== null && (
          <button type="button" className="list-head__hint notes__clear-filter" onClick={() => setFilter(null)}>
            清掉筛选
          </button>
        )}
      </div>

      <ul className="panel__list" data-page-body ref={listRef}>
        {notes.map((note) => {
          const long = isLong(note.body);
          const open = opened.includes(note.id);

          if (editing === note.id) {
            return (
              <li key={note.id} className="note note--editing">
                <textarea
                  ref={editRef}
                  className="notes__edit"
                  value={editText}
                  onChange={(event) => setEditText(event.target.value)}
                  onKeyDown={(event) => {
                    // 这个 Esc 只用来取消编辑，吃掉它，别让面板跟着关掉
                    if (event.key === "Escape") {
                      event.preventDefault();
                      cancelEdit();
                    }
                    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
                      event.preventDefault();
                      void saveEdit();
                    }
                  }}
                  aria-label="编辑备忘"
                  spellCheck={false}
                />

                <TagPicker
                  tags={tags}
                  selected={editTags}
                  onToggle={(id) =>
                    setEditTags((prev) =>
                      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
                    )
                  }
                  onCreate={createTag}
                />

                <div className="note__foot">
                  <span className="note__at">Ctrl + Enter 保存</span>
                  <div className="note__acts note__acts--on">
                    <button type="button" className="note__act" onClick={cancelEdit}>
                      取消
                    </button>
                    <button
                      type="button"
                      className="note__act note__act--brand"
                      onClick={() => void saveEdit()}
                    >
                      保存
                    </button>
                  </div>
                </div>
              </li>
            );
          }

          return (
            <li
              key={note.id}
              data-note-id={note.id}
              className={`note${note.pinned ? " note--pinned" : ""}${
                copied === note.id ? " note--copied" : ""
              }${flashNote === note.id ? " note--flash" : ""}`}
              // 整张卡片就是「复制这条」。里面那排按钮（标签、展开、置顶…）各管各的，
              // 点它们不该顺手把正文复制一遍，所以用 closest 拦一道。
              onClick={(event) => {
                if (!(event.target instanceof HTMLElement)) return;
                if (event.target.closest("button") !== null) return;
                // 正在拖选文字时不抢：拖选结束也会冒泡成一次 click
                const selection = window.getSelection();
                if (selection !== null && selection.toString() !== "") return;
                void copyNote(note);
              }}
              onKeyDown={(event) => {
                // 只有焦点在卡片本身时才接管，里面的按钮照常响应自己的键
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  void copyNote(note);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={`复制备忘：${note.body.slice(0, 24)}`}
            >
              <p className={`note__body${long && !open ? " note__body--fold" : ""}`}>{note.body}</p>

              {note.tags.length > 0 && (
                <div className="note__tags">
                  {note.tags.map((tag) => (
                    <button
                      key={tag.id}
                      type="button"
                      className={`note__tag${filter === tag.id ? " note__tag--on" : ""}`}
                      onClick={() => setFilter(filter === tag.id ? null : tag.id)}
                      title={`只看 #${tag.name}`}
                    >
                      #{tag.name}
                    </button>
                  ))}
                </div>
              )}

              <div className="note__foot">
                {/* 时间这一格兼作反馈位：复制成功后临时换成「已复制」，
                    反馈就在手指点的地方，不用抬头找 toast */}
                <span className={`note__at${copied === note.id ? " note__at--copied" : ""}`}>
                  {copied === note.id ? "已复制" : formatClock(note.updated_at)}
                </span>
                {long && (
                  <button type="button" className="note__fold" onClick={() => toggleOpen(note.id)}>
                    {open ? "收起" : "展开"}
                  </button>
                )}
                <div className="note__acts">
                  <button type="button" className="note__act" onClick={() => void togglePin(note)}>
                    {note.pinned ? "取消置顶" : "置顶"}
                  </button>
                  <button type="button" className="note__act" onClick={() => startEdit(note)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className={`note__act note__act--danger${confirming === note.id ? " note__act--armed" : ""}`}
                    onClick={() => void remove(note.id)}
                  >
                    {confirming === note.id ? "确定删除？" : "删除"}
                  </button>
                </div>
              </div>
            </li>
          );
        })}

        {!loading && notes.length === 0 && (
          <li className="panel__empty">
            {filter === null ? "还没有备忘" : "这个标签下还没有备忘"}
            <span>
              {filter === null
                ? "上面写一句，按 Ctrl + Enter 就存下来了"
                : "写一条，或者点上面的「全部」看看别的"}
            </span>
          </li>
        )}
      </ul>
    </>
  );
}

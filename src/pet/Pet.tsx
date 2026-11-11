import { useEffect, useRef, useState } from "react";
import { STATE_POSE, poseUrl, type PetMeta, type PetState } from "./poses";
import { useBlink } from "./useBlink";
import "./pet.css";

interface PetProps {
  state: PetState;
  meta: PetMeta | null;
}

const FADE_MS = 180;

export function Pet({ state, meta }: PetProps) {
  const pose = STATE_POSE[state];
  const eyes = meta?.poses[pose]?.eyes;
  const blinking = useBlink(Boolean(eyes));

  // 交叉淡入：切图时保留旧图淡出，避免硬切
  const [outgoing, setOutgoing] = useState<string | null>(null);
  const currentPose = useRef(pose);

  useEffect(() => {
    if (currentPose.current === pose) return;
    const previous = currentPose.current;
    currentPose.current = pose;
    setOutgoing(previous);
    const timer = window.setTimeout(() => setOutgoing(null), FADE_MS);
    return () => window.clearTimeout(timer);
  }, [pose]);

  const scale = meta ? meta.displaySize / meta.canvas : 0.5;

  const eyeStyle = (centerX: number) =>
    eyes
      ? {
          left: (centerX - eyes.width / 2) * scale,
          top: (eyes.y - eyes.height * 0.275) * scale,
          width: eyes.width * scale,
          height: eyes.height * scale * 0.55,
          opacity: blinking ? 1 : 0,
        }
      : undefined;

  return (
    <div className={`pet pet--${state}`}>
      <div className="pet__breathe">
        {outgoing && (
          <img
            className="pet__img pet__img--out"
            src={poseUrl(outgoing)}
            alt=""
            draggable={false}
          />
        )}
        <img
          className="pet__img"
          src={poseUrl(pose)}
          alt="鲸鱼娘"
          draggable={false}
        />
        {eyes && (
          <>
            <span className="pet__eye" style={eyeStyle(eyes.leftX)} />
            <span className="pet__eye" style={eyeStyle(eyes.rightX)} />
          </>
        )}
      </div>
    </div>
  );
}

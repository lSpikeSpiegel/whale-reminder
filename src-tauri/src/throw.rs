//! 「甩出去」：松手时按拖动速度让窗口滑一段，撞到工作区边缘反弹，慢慢停下。
//!
//! 全部是纯几何，`step` 不碰窗口也不碰时钟，所以能在单测里一帧一帧地跑完整个
//! 滑行过程——这类手感代码如果只能靠肉眼看，边界条件（撞角、速度给到极端值）
//! 基本测不出来。

/// 每帧速度衰减系数。60fps 下大约 1.5 秒滑停，手感是「推一把、滑一小段」。
pub const FRICTION: f64 = 0.94;
/// 撞边后保留的速度比例。太低像撞墙，太高会一直弹。
pub const BOUNCE: f64 = 0.5;
/// 低于这个速度（像素/毫秒）就算停住。
pub const REST_SPEED: f64 = 0.03;
/// 初速度上限（像素/毫秒）。拖得再快也不该一甩飞出屏幕。
pub const MAX_SPEED: f64 = 3.0;

#[derive(Debug, Clone, Copy)]
pub struct Body {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

impl Body {
    /// 把初速度压到上限以内。
    pub fn clamped(mut self) -> Self {
        let speed = self.vx.hypot(self.vy);
        if speed > MAX_SPEED {
            let k = MAX_SPEED / speed;
            self.vx *= k;
            self.vy *= k;
        }
        self
    }

    pub fn at_rest(&self) -> bool {
        self.vx == 0.0 && self.vy == 0.0
    }
}

/// 走一帧，返回这一帧有没有撞到边。
pub fn step(body: &mut Body, bounds: &Bounds, dt: f64) -> bool {
    body.x += body.vx * dt;
    body.y += body.vy * dt;

    let mut bounced = false;
    if body.x < bounds.min_x {
        body.x = bounds.min_x;
        body.vx = -body.vx * BOUNCE;
        bounced = true;
    } else if body.x > bounds.max_x {
        body.x = bounds.max_x;
        body.vx = -body.vx * BOUNCE;
        bounced = true;
    }
    if body.y < bounds.min_y {
        body.y = bounds.min_y;
        body.vy = -body.vy * BOUNCE;
        bounced = true;
    } else if body.y > bounds.max_y {
        body.y = bounds.max_y;
        body.vy = -body.vy * BOUNCE;
        bounced = true;
    }

    body.vx *= FRICTION;
    body.vy *= FRICTION;
    if body.vx.abs() < REST_SPEED {
        body.vx = 0.0;
    }
    if body.vy.abs() < REST_SPEED {
        body.vy = 0.0;
    }
    bounced
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds() -> Bounds {
        Bounds {
            min_x: 0.0,
            min_y: 0.0,
            max_x: 1_000.0,
            max_y: 800.0,
        }
    }

    #[test]
    fn moves_by_speed_times_time() {
        let mut body = Body {
            x: 100.0,
            y: 100.0,
            vx: 1.0,
            vy: -0.5,
        };
        step(&mut body, &bounds(), 16.0);
        assert!((body.x - 116.0).abs() < 1e-6);
        assert!((body.y - 92.0).abs() < 1e-6);
    }

    #[test]
    fn right_edge_flips_and_damps() {
        let mut body = Body {
            x: 995.0,
            y: 400.0,
            vx: 1.0,
            vy: 0.0,
        };
        assert!(step(&mut body, &bounds(), 16.0));
        assert_eq!(body.x, 1_000.0);
        assert!(body.vx < 0.0, "撞右边应该往回弹");
        // 反弹后速度必须小于入射速度（FRICTION × BOUNCE）
        assert!(body.vx.abs() < 1.0 * BOUNCE + 1e-9);
    }

    #[test]
    fn corner_bounces_on_both_axes() {
        let mut body = Body {
            x: 999.0,
            y: 799.0,
            vx: 1.0,
            vy: 1.0,
        };
        step(&mut body, &bounds(), 16.0);
        assert!(body.vx < 0.0 && body.vy < 0.0);
    }

    #[test]
    fn always_stops_inside_bounds() {
        let mut body = Body {
            x: 500.0,
            y: 400.0,
            vx: MAX_SPEED,
            vy: MAX_SPEED,
        };
        for _ in 0..2_000 {
            step(&mut body, &bounds(), 16.0);
            assert!(body.x >= 0.0 && body.x <= 1_000.0, "x 越界：{}", body.x);
            assert!(body.y >= 0.0 && body.y <= 800.0, "y 越界：{}", body.y);
            if body.at_rest() {
                break;
            }
        }
        assert!(body.at_rest(), "2 秒内应该停下来");
    }

    #[test]
    fn huge_throw_speed_is_clamped() {
        let body = Body {
            x: 0.0,
            y: 0.0,
            vx: 100.0,
            vy: 0.0,
        }
        .clamped();
        assert!((body.vx - MAX_SPEED).abs() < 1e-9);
    }

    #[test]
    fn zero_speed_is_already_at_rest() {
        let mut body = Body {
            x: 10.0,
            y: 10.0,
            vx: 0.0,
            vy: 0.0,
        };
        step(&mut body, &bounds(), 16.0);
        assert!(body.at_rest());
        assert_eq!(body.x, 10.0);
    }
}

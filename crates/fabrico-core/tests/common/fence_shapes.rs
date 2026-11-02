//! The Factory programs that measure the memory, stack and gas limits. This is the one copy: the
//! native pins in `factory_memory_pin.rs` and the wasm build's probes both include this file by
//! path, so a shape can't differ between the two targets. A different program gives a different
//! count, so the text of each one is part of what its pin means.

#![allow(dead_code)]

/// 1000-element arrays: each one is a block over QuickJS's 512-byte arena limit, so the
/// allocator sees every allocation directly.
pub fn arrays(n: u64) -> String {
    format!(
        "export default function(i, ctx) {{ const a = []; for (let k = 0; k < {n}; k++) \
         a.push(new Array(1000).fill(k)); ctx.state = {{ n: a.length }}; }}"
    )
}

/// 1 KiB strings: also over the arena limit, and built by a different path through QuickJS.
pub fn strings(n: u64) -> String {
    format!(
        "export default function(i, ctx) {{ const a=[]; for (let k = 0; k < {n}; k++) \
         a.push('y'.repeat(1024) + k); ctx.state = {{ n: a.length }}; }}"
    )
}

/// Small objects: these come from QuickJS's arena, so the allocator sees only its chunks.
pub fn objects(n: u64) -> String {
    format!(
        "export default function(i, ctx) {{ const a=[]; for (let k = 0; k < {n}; k++) \
         a.push({{k}}); ctx.state = {{ n: a.length }}; }}"
    )
}

/// Each object refers to itself. One in two stays in the array and the other is dropped, so
/// the dropped ones are garbage only the cycle collector can free. QuickJS's automatic collector
/// decides when to run from a total that includes `MALLOC_OVERHEAD`, so this count moves with
/// that constant unless the automatic collector is off.
pub fn cyclic(n: u64) -> String {
    format!(
        "export default function(i, ctx) {{ const a=[]; for (let k = 0; k < {n}; k++) \
         {{ const o = {{k}}; o.self = o; if (k % 2 === 0) a.push(o); }} \
         ctx.state = {{ n: a.length }}; }}"
    )
}

/// Plain recursion to `depth`.
pub fn recursion(depth: u64) -> String {
    format!(
        "export default function(i, ctx) {{ function f(k) {{ return k === 0 ? 0 : 1 + f(k - 1); }} \
         ctx.state = {{ d: f({depth}) }}; }}"
    )
}

/// A loop of `n` additions. Under the default gas budget the first count that trips the fuse is
/// the gas threshold, which has to be the same on every target.
pub fn gas_loop(n: u64) -> String {
    format!(
        "export default function(i, ctx) {{ let x = 0; for (let k = 0; k < {n}; k++) x += k; \
         ctx.state = {{ x }}; }}"
    )
}

/// Recursion through `Array.map`, to `depth`. A scan of the source can't see this recursion,
/// and each level goes through the engine's native `map`, so it spends more of both stacks per
/// call than [`recursion`] does.
pub fn map_recursion(depth: u64) -> String {
    format!(
        "export default function(i, ctx) {{ function f(k) {{ return k === 0 ? 0 : [k - 1].map(f)[0] + 1; }} \
         ctx.state = {{ d: f({depth}) }}; }}"
    )
}

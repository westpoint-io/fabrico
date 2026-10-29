//! Logical, serializable id/value handles for the sim (API-03, CORE-09).
//!
//! Nodes and belts are addressed by **generational slotmap keys**, never by raw
//! in-memory pointers — satisfying "addressed logically as `(node-id, port)`"
//! and keeping all state fully serializable plain data.
//!
//! # Ordering discipline (RESEARCH Pitfall 3)
//! `slotmap` keys implement `Ord` (the `Key` trait bounds it), so [`NodeId`] /
//! [`BeltId`] are valid `BTreeMap` keys. The authoritative ordered store of
//! nodes is a `BTreeMap<NodeId, _>` (CONTEXT-locked). A `SlotMap` is used ONLY
//! to mint generational keys + O(1) liveness/presence checks — **never** iterate
//! a `SlotMap` for order-observed logic, because slot order is an internal
//! layout detail, not a deterministic logical order.

use slotmap::new_key_type;

new_key_type! {
    /// Generational handle for a node (machine) in the grid.
    pub struct NodeId;
    /// Generational handle for a belt (channel) in the grid.
    pub struct BeltId;
}

/// Port index on a node. Input and output ports are addressed by this index;
/// the deterministic port-priority rule (ROUTE-06) orders by lowest index.
pub type PortId = u16;

/// Logical partition key carried by every event (CORE-08). Ignored in
/// single-partition mode; reserved for the forward-compatible sharded design.
pub type PartitionKey = u64;

/// An item travelling on a belt: opaque plain bytes, plain serializable data only.
/// There is no typed payload. Factories exchange values as canonical JSON text at the
/// JS boundary; the core never decodes an item.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Item(pub Vec<u8>);

/// Deterministic idempotency key for a dispatched command:
/// `(tick, source node, per-tick sequence)`. Derived entirely from logged data
/// so the Phase 5 executor can enforce exactly-once from the log alone.
pub type CommandId = (u64, NodeId, u32);

#[cfg(test)]
mod tests {
    use super::*;
    use slotmap::SlotMap;
    use std::collections::BTreeMap;

    #[test]
    fn ids_node_id_is_btreemap_key_and_round_trips() {
        // Mint a real generational key from a SlotMap (key-minting only).
        let mut alloc: SlotMap<NodeId, ()> = SlotMap::with_key();
        let n0 = alloc.insert(());
        let n1 = alloc.insert(());

        // NodeId is Ord -> usable as a BTreeMap key (deterministic iteration).
        let mut map: BTreeMap<NodeId, u8> = BTreeMap::new();
        map.insert(n0, 10);
        map.insert(n1, 20);
        assert_eq!(map.get(&n0), Some(&10));
        assert_eq!(map.get(&n1), Some(&20));

        // The whole map round-trips through postcard (plain serializable data).
        let bytes = postcard::to_allocvec(&map).expect("serialize node map");
        let restored: BTreeMap<NodeId, u8> =
            postcard::from_bytes(&bytes).expect("deserialize node map");
        assert_eq!(map, restored);
    }

    #[test]
    fn ids_item_round_trips() {
        let item = Item(vec![1, 2, 3, 4]);
        let bytes = postcard::to_allocvec(&item).expect("serialize item");
        let restored: Item = postcard::from_bytes(&bytes).expect("deserialize item");
        assert_eq!(item, restored);
    }
}

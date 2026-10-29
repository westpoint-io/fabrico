//! One answer per gesture (phase 88, D-06): the verdict frame both transports write, and the
//! sink the sim-loop drain answers each gesture through.
//!
//! # Every gesture gets exactly one answer
//! Until plan 88-03 only a REFUSED gesture produced a frame; an accepted one produced nothing
//! (D-30), so the client inferred an accept from the cell, kind and emit order of the next
//! packet. That inference is what put a follow-up Rotate on the wrong Source (WORK-04) and
//! dropped a belt's owed Dock during a long drain (BELT-05). Now each gesture is answered once,
//! by one of three frames, each naming the gesture by the client's own id (`seq`):
//!
//! - `{kind: "gestureRefused", seq?, tag, cmd?, node?}`: the host refused it. `seq` is absent
//!   only when the frame header itself could not be read, so the frame names no gesture.
//! - `{kind: "gestureAccepted", seq, generation, minted}`: the host accepted it and the tick
//!   that folded it has run. `minted` lists the render handles its Place, DrawBelt or
//!   DrawWire records minted, in fold order (a DrawWire names two), in the handle table of
//!   `generation`, the table of the packet that tick broadcast.
//! - `{kind: "gestureDiscarded", seq}`: a board swap (Load, an example, New) dropped it before
//!   it folded (D-05). No sentence goes with it: the user asked for the board to be replaced.
//!
//! A field that is absent is OMITTED, never `null`. The client's sentence rule is unchanged:
//! only a refusal shows one (Pitfall 8); an accept and a discard are silent to the user.
//!
//! # One sink per transport, no task per gesture
//! Each gesture's envelope carries a [`VerdictSink`]: its gesture id, its subject, and a clone
//! of ONE unbounded sender per transport subscription (one per dev WebSocket connection, one
//! per Tauri `subscribe_gesture_verdicts` call, so a webview reload gets a sender of its own and
//! never hears the old page's answers; phase 88 review CR-01). The drain consumes the sink with
//! exactly one of [`VerdictSink::refused`], [`VerdictSink::accepted`] or
//! [`VerdictSink::discarded`], and the transport writes whatever arrives on its channel. No task waits per gesture, so nothing needs a time bound: a verdict
//! produced after a pause of any length still reaches the client.
//!
//! # What may ride these frames (T-64-05-02, T-74.1-98, T-88-08)
//! A fieldless tag, a fixed command name, integers: the client's own gesture id, a reset count,
//! and render handles. Every handle is a `NodeView.id` the same client already receives in
//! every render packet. No path, internal index or host `Display` string rides any of them.

use serde::Serialize;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use crate::command_error_view::CommandErrorView;
use crate::sim_loop::GestureSubject;
use crate::transport_ws::{GESTURE_ACCEPT_KIND, GESTURE_DISCARD_KIND, GESTURE_REFUSAL_KIND};

/// The ONE verdict frame both transports write: the dev WebSocket as a TEXT frame, the Tauri
/// shell down the webview's verdict channel. Built only by [`refused`](Self::refused),
/// [`accepted`](Self::accepted) and [`discarded`](Self::discarded), so a frame cannot carry a
/// field its kind does not have.
///
/// # Why there is NO request-id field (carried from Phase 64's refusal frame)
/// The dev WebSocket's config-query reply is both the analog and the trap. The frontend's
/// config-query resolver (`devWsInvoke.ts::resolveDevWsReply`) keys on `reqId` ALONE, and its
/// `nextReqId` counter and the page's gesture ids BOTH start at 1. A request id on a verdict
/// would therefore resolve an unrelated in-flight config query with a verdict, and a config
/// panel would render a machine's configuration as the word `MediumMismatch` (threat
/// T-64-05-01).
///
/// # Why `kind` exists
/// Outbound TEXT frames carried no kind tag before Phase 64, and the query resolver returns
/// `false` for anything it does not recognise with no console warning and no else branch. An
/// untagged frame would be swallowed in silence. `kind` is the discriminator the frontend's
/// verdict grammar keys on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct VerdictFrame {
    /// [`GESTURE_REFUSAL_KIND`], [`GESTURE_ACCEPT_KIND`] or [`GESTURE_DISCARD_KIND`].
    kind: &'static str,
    /// The client's own id for the gesture this answers.
    #[serde(skip_serializing_if = "Option::is_none")]
    seq: Option<u64>,
    /// A refusal's typed tag, a bare string the frontend copy table keys on.
    #[serde(skip_serializing_if = "Option::is_none")]
    tag: Option<CommandErrorView>,
    /// A refusal's command variant name (plan 74.1-28).
    #[serde(skip_serializing_if = "Option::is_none")]
    cmd: Option<&'static str>,
    /// A refusal's one named node, as a render handle (plan 74.1-28).
    #[serde(skip_serializing_if = "Option::is_none")]
    node: Option<u64>,
    /// An accept's board generation: the handle table `minted` belongs to.
    #[serde(skip_serializing_if = "Option::is_none")]
    generation: Option<u64>,
    /// An accept's minted render handles, in fold order.
    #[serde(skip_serializing_if = "Option::is_none")]
    minted: Option<Vec<u64>>,
}

impl VerdictFrame {
    /// Gesture `seq` was refused with `tag`. `seq` is `None` only for a frame whose header
    /// could not be read; `subject` is `None` for a frame whose body could not be read.
    #[must_use]
    pub fn refused(seq: Option<u64>, tag: CommandErrorView, subject: Option<GestureSubject>) -> Self {
        Self {
            kind: GESTURE_REFUSAL_KIND,
            seq,
            tag: Some(tag),
            cmd: subject.map(|s| s.cmd),
            node: subject.and_then(|s| s.node),
            generation: None,
            minted: None,
        }
    }

    /// Gesture `seq` was accepted and has folded; `minted` are the render handles it minted, in
    /// the handle table of `generation`.
    #[must_use]
    pub fn accepted(seq: u64, generation: u64, minted: Vec<u64>) -> Self {
        Self {
            kind: GESTURE_ACCEPT_KIND,
            seq: Some(seq),
            tag: None,
            cmd: None,
            node: None,
            generation: Some(generation),
            minted: Some(minted),
        }
    }

    /// Gesture `seq` was dropped by a board swap before it folded (D-05).
    #[must_use]
    pub fn discarded(seq: u64) -> Self {
        Self {
            kind: GESTURE_DISCARD_KIND,
            seq: Some(seq),
            tag: None,
            cmd: None,
            node: None,
            generation: None,
            minted: None,
        }
    }

    /// The frame's kind discriminator.
    #[must_use]
    pub fn kind(&self) -> &'static str {
        self.kind
    }

    /// The gesture id this answers, if the frame names one.
    #[must_use]
    pub fn seq(&self) -> Option<u64> {
        self.seq
    }

    /// A refusal's tag; `None` on an accept or a discard.
    #[must_use]
    pub fn tag(&self) -> Option<CommandErrorView> {
        self.tag
    }

    /// An accept's board generation; `None` on a refusal or a discard.
    #[must_use]
    pub fn generation(&self) -> Option<u64> {
        self.generation
    }

    /// An accept's minted handles; `None` on a refusal or a discard.
    #[must_use]
    pub fn minted(&self) -> Option<&[u64]> {
        self.minted.as_deref()
    }

    /// The JSON text the dev WebSocket writes. Never panics: a serialize failure degrades to
    /// an empty frame the frontend's reject-only parser ignores (the `ok_reply` idiom).
    #[must_use]
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

/// The sending half of one transport's verdict channel. Unbounded on purpose, and bounded in
/// practice by what feeds it: exactly one verdict per gesture frame received, so it grows no
/// faster than the unbounded gesture channel it mirrors (T-88-07), and no task waits on it.
pub type VerdictTx = UnboundedSender<VerdictFrame>;

/// The receiving half: the dev WebSocket's select loop, or the forwarder of one Tauri verdict
/// route.
pub type VerdictRx = UnboundedReceiver<VerdictFrame>;

/// The ONE verdict-channel constructor, so the channel's item type is named in one place.
#[must_use]
pub fn verdict_channel() -> (VerdictTx, VerdictRx) {
    unbounded_channel()
}

/// Where ONE gesture's verdict goes: its gesture id, its subject, and its transport's verdict
/// sender. Consumed by exactly one of [`refused`](Self::refused),
/// [`accepted`](Self::accepted) or [`discarded`](Self::discarded), so a gesture cannot be
/// answered twice. Each send is drop-safe: a transport whose receiver is gone (the socket
/// closed, the webview reloaded) is not an error and never stops the drain.
#[derive(Debug)]
pub struct VerdictSink {
    gesture_id: u64,
    subject: GestureSubject,
    tx: VerdictTx,
}

impl VerdictSink {
    /// The sink for gesture `gesture_id`, whose refusal names `subject`, answering on `tx`.
    #[must_use]
    pub fn new(gesture_id: u64, subject: GestureSubject, tx: VerdictTx) -> Self {
        Self {
            gesture_id,
            subject,
            tx,
        }
    }

    /// The client's id for the gesture this sink answers.
    #[must_use]
    pub fn gesture_id(&self) -> u64 {
        self.gesture_id
    }

    /// Answer: refused with `tag`.
    pub fn refused(self, tag: CommandErrorView) {
        let _ = self
            .tx
            .send(VerdictFrame::refused(Some(self.gesture_id), tag, Some(self.subject)));
    }

    /// Answer: accepted and folded, having minted `minted` in the table of `generation`.
    pub fn accepted(self, generation: u64, minted: Vec<u64>) {
        let _ = self
            .tx
            .send(VerdictFrame::accepted(self.gesture_id, generation, minted));
    }

    /// Answer: dropped by a board swap before it folded.
    pub fn discarded(self) {
        let _ = self.tx.send(VerdictFrame::discarded(self.gesture_id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PLACE: GestureSubject = GestureSubject {
        cmd: "Place",
        node: None,
    };

    /// Each kind carries exactly its own fields, absent ones omitted rather than `null`.
    #[test]
    fn each_frame_kind_carries_exactly_its_own_fields() {
        let refused = serde_json::to_value(VerdictFrame::refused(
            Some(4),
            CommandErrorView::FootprintCollision,
            Some(PLACE),
        ))
        .unwrap();
        assert_eq!(
            refused,
            serde_json::json!({"kind": "gestureRefused", "seq": 4, "tag": "FootprintCollision", "cmd": "Place"})
        );
        let unreadable =
            serde_json::to_value(VerdictFrame::refused(None, CommandErrorView::Malformed, None)).unwrap();
        assert_eq!(unreadable, serde_json::json!({"kind": "gestureRefused", "tag": "Malformed"}));
        let accepted = serde_json::to_value(VerdictFrame::accepted(5, 2, vec![9, 10])).unwrap();
        assert_eq!(
            accepted,
            serde_json::json!({"kind": "gestureAccepted", "seq": 5, "generation": 2, "minted": [9, 10]})
        );
        let none_minted = serde_json::to_value(VerdictFrame::accepted(6, 0, Vec::new())).unwrap();
        assert_eq!(
            none_minted,
            serde_json::json!({"kind": "gestureAccepted", "seq": 6, "generation": 0, "minted": []}),
            "an accept that minted nothing still says so, with an empty list"
        );
        let discarded = serde_json::to_value(VerdictFrame::discarded(7)).unwrap();
        assert_eq!(discarded, serde_json::json!({"kind": "gestureDiscarded", "seq": 7}));
    }

    /// A sink answers once on its transport's channel, and a gone receiver is not an error.
    #[test]
    fn a_sink_answers_once_and_a_closed_channel_is_not_an_error() {
        let (tx, mut rx) = verdict_channel();
        VerdictSink::new(3, PLACE, tx.clone()).accepted(1, vec![8]);
        assert_eq!(rx.try_recv().expect("answered"), VerdictFrame::accepted(3, 1, vec![8]));
        assert!(rx.try_recv().is_err(), "exactly one frame per answer");
        VerdictSink::new(4, PLACE, tx.clone()).discarded();
        assert_eq!(rx.try_recv().expect("answered").kind(), GESTURE_DISCARD_KIND);
        drop(rx);
        // The socket closed: the answer goes nowhere, and nothing panics.
        VerdictSink::new(5, PLACE, tx).refused(CommandErrorView::OutOfBounds);
    }
}

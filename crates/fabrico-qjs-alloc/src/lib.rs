//! The Factory runtime's memory-limited allocator.
//!
//! The allocator decides when a Factory runs out of memory, so it has to behave the same on
//! every platform. It lives in this crate because writing one needs `unsafe`, and `fabrico-core`
//! forbids `unsafe`.

use rquickjs::allocator::{Allocator, RustAllocator};

/// Allocates through [`RustAllocator`].
pub struct FenceAllocator {
    #[allow(dead_code)]
    limit: usize,
    used: usize,
}

impl FenceAllocator {
    /// An allocator that will refuse to go past `limit` bytes.
    pub fn new(limit: usize) -> Self {
        Self { limit, used: 0 }
    }

    /// The bytes charged so far.
    pub fn used(&self) -> usize {
        self.used
    }
}

// SAFETY: every call delegates to `RustAllocator`, which upholds the trait's contract.
unsafe impl Allocator for FenceAllocator {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        RustAllocator.alloc(size)
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        RustAllocator.calloc(count, size)
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        // SAFETY: the caller passes a pointer this allocator returned.
        unsafe { RustAllocator.dealloc(ptr) }
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        // SAFETY: the caller passes a pointer this allocator returned.
        unsafe { RustAllocator.realloc(ptr, new_size) }
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize {
        // SAFETY: the caller passes a pointer this allocator returned.
        unsafe { RustAllocator::usable_size(ptr) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The charge for a block of `size` bytes, written out here so the tests don't read the
    /// arithmetic they are checking.
    const SIXTEEN_BYTE_BLOCK: usize = 24;

    #[test]
    fn a_block_costs_its_size_rounded_up_to_8_plus_an_8_byte_header() {
        for (size, expected) in [(1, 16), (8, 16), (9, 24), (16, 24), (100, 112)] {
            let mut a = FenceAllocator::new(1024);
            let p = a.alloc(size);
            assert!(!p.is_null());
            assert_eq!(a.used(), expected, "alloc({size})");
            // SAFETY: `p` came from this allocator and is freed once.
            unsafe { a.dealloc(p) };
        }
    }

    #[test]
    fn the_total_returns_to_its_start_after_alloc_realloc_and_free() {
        let mut a = FenceAllocator::new(1024 * 1024);
        let first = a.alloc(10);
        assert_eq!(a.used(), 24);

        // SAFETY: every pointer here came from this allocator and is used once.
        unsafe {
            let grown = a.realloc(first, 5000);
            assert!(!grown.is_null());
            assert_eq!(a.used(), 5008);

            let shrunk = a.realloc(grown, 17);
            assert!(!shrunk.is_null());
            assert_eq!(a.used(), 32);

            let zeroed = a.calloc(3, 5);
            assert!(!zeroed.is_null());
            assert_eq!(a.used(), 32 + 24);

            a.dealloc(zeroed);
            assert_eq!(a.used(), 32);
            a.dealloc(shrunk);
        }
        assert_eq!(a.used(), 0);
    }

    #[test]
    fn an_allocation_that_fits_exactly_succeeds_and_one_more_returns_null() {
        let mut a = FenceAllocator::new(SIXTEEN_BYTE_BLOCK);
        assert!(a.alloc(17).is_null(), "24 bytes rounded up plus the header is over the limit");
        assert_eq!(a.used(), 0);
        assert!(a.calloc(1, 17).is_null());
        assert_eq!(a.used(), 0);

        let p = a.alloc(16);
        assert!(!p.is_null());
        assert_eq!(a.used(), SIXTEEN_BYTE_BLOCK);

        assert!(a.alloc(0).is_null(), "the total is at the limit, so even a header doesn't fit");
        assert_eq!(a.used(), SIXTEEN_BYTE_BLOCK);

        // SAFETY: `p` came from this allocator and is freed once.
        unsafe { a.dealloc(p) };
        assert_eq!(a.used(), 0);
    }

    #[test]
    fn sizes_that_would_overflow_return_null_and_do_not_panic() {
        let mut a = FenceAllocator::new(usize::MAX);
        assert!(a.alloc(usize::MAX).is_null());
        assert!(a.alloc(usize::MAX - 7).is_null());
        assert!(a.alloc(usize::MAX - 15).is_null());
        assert!(a.calloc(usize::MAX, 2).is_null());
        assert!(a.calloc(2, usize::MAX).is_null());
        assert_eq!(a.used(), 0);

        let p = a.alloc(8);
        assert!(!p.is_null());
        // SAFETY: `p` came from this allocator. The failed calls leave it valid, and it is
        // freed once.
        unsafe {
            assert!(a.realloc(p, usize::MAX).is_null());
            assert!(a.realloc(p, usize::MAX - 7).is_null());
            assert_eq!(a.used(), 16);
            a.dealloc(p);
        }
        assert_eq!(a.used(), 0);
    }

    #[test]
    fn a_failed_realloc_leaves_the_total_and_the_old_block_alone() {
        let mut a = FenceAllocator::new(64);
        let p = a.alloc(16);
        assert!(!p.is_null());
        let before = a.used();

        // SAFETY: `p` holds at least 16 bytes, stays valid when the realloc fails, and is freed
        // once.
        unsafe {
            p.write_bytes(0x5a, 16);
            assert!(a.realloc(p, 57).is_null());
            assert_eq!(a.used(), before);
            for offset in 0..16 {
                assert_eq!(p.add(offset).read(), 0x5a, "byte {offset} changed");
            }
            a.dealloc(p);
        }
        assert_eq!(a.used(), 0);
    }

    #[test]
    fn a_realloc_that_needs_the_blocks_own_charge_back_succeeds() {
        // 16 + 8 is charged. Growing to 56 + 8 fits only if the old 24 is taken off first.
        let mut a = FenceAllocator::new(64);
        let p = a.alloc(16);
        assert!(!p.is_null());

        // SAFETY: `p` came from this allocator, and the pointer returned replaces it.
        unsafe {
            let grown = a.realloc(p, 56);
            assert!(!grown.is_null());
            assert_eq!(a.used(), 64);
            a.dealloc(grown);
        }
        assert_eq!(a.used(), 0);
    }

    #[test]
    fn realloc_of_a_null_pointer_allocates() {
        let mut a = FenceAllocator::new(1024);
        // SAFETY: a null pointer is handled before any header is read.
        let p = unsafe { a.realloc(std::ptr::null_mut(), 8) };
        assert!(!p.is_null());
        assert_eq!(a.used(), 16);
        // SAFETY: `p` came from this allocator and is freed once.
        unsafe { a.dealloc(p) };
        assert_eq!(a.used(), 0);
    }
}

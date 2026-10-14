use std::sync::atomic::{AtomicU32, Ordering};

#[cfg(any(target_os = "macos", test))]
pub(crate) fn panel_or_cancel<T>(panel: Option<T>, cancel: impl FnOnce()) -> Option<T> {
  if panel.is_none() {
    cancel();
  }
  panel
}

#[cfg(test)]
mod file_picker_tests {
  use super::panel_or_cancel;
  use std::cell::Cell;

  #[test]
  fn unavailable_panel_cancels_the_webkit_request_without_panicking() {
    let completions = Cell::new(0);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
      panel_or_cancel::<()>(None, || completions.set(completions.get() + 1))
    }));
    assert!(result.unwrap().is_none());
    assert_eq!(completions.get(), 1);
  }

  #[test]
  fn available_panel_remains_usable_without_cancelling_the_request() {
    let selected_images = vec!["first.png", "second.jpg"];
    let result = panel_or_cancel(Some(selected_images), || panic!("valid panel was cancelled"));
    assert_eq!(result.unwrap(), vec!["first.png", "second.jpg"]);
  }
}

pub struct Counter(AtomicU32);

impl Counter {
  pub const fn new() -> Self {
    Self(AtomicU32::new(1))
  }

  pub fn next(&self) -> u32 {
    self.0.fetch_add(1, Ordering::Relaxed)
  }
}

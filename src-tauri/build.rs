use std::{path::PathBuf, process::Command};

fn main() {
  tauri_build::build();
  if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
    adblock();
  }
}

fn adblock() {
  println!("cargo:rerun-if-changed=adblock/adblock.zig");
  println!("cargo:rerun-if-changed=adblock/easylist.json");
  let out = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
  let zig = std::env::var("ZIG").unwrap_or_else(|_| "zig".into());
  let status = Command::new(zig)
    .args(["build-lib", "adblock/adblock.zig", "-lc", "-OReleaseSafe", "-fPIC", "-fno-stack-check"])
    .arg("--cache-dir")
    .arg(out.join("zig-cache"))
    .arg("--global-cache-dir")
    .arg(out.join("zig-cache"))
    .arg(format!("-femit-bin={}", out.join("libvc_adblock.a").display()))
    .status()
    .expect("zig is needed on Linux to build the ad blocker (adblock/adblock.zig)");
  assert!(status.success(), "zig build-lib adblock/adblock.zig failed");
  println!("cargo:rustc-link-search=native={}", out.display());
  println!("cargo:rustc-link-lib=static=vc_adblock");
}

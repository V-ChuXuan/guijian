#![cfg(windows)]

use std::fs::{self, File};
use std::os::windows::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use desktop_lib::cleanup::{TrashPort, WindowsTrash};

// Run explicitly: cargo test --locked --test windows_shell -- --ignored --test-threads=1
// Recycled synthetic files are left in the Recycle Bin; this suite never empties it.
struct ShellFixture {
    root: PathBuf,
}

impl ShellFixture {
    fn new(label: &str) -> Self {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "guijian-shell-{label}-{}-{unique}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        Self { root }
    }

    fn write(&self, relative: impl AsRef<Path>, content: &[u8]) -> PathBuf {
        let path = self.root.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, content).unwrap();
        path
    }
}

impl Drop for ShellFixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.root)
            .expect("remove only this test's synthetic fixture directory");
    }
}

fn assert_recycled(path: &Path) {
    assert!(
        !path.exists(),
        "the source must no longer exist after recycling"
    );
    // Query only a boolean for this unique fixture, without exposing unrelated bin entries.
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference='Stop'; $bin=(New-Object -ComObject Shell.Application).Namespace(10); $found=$false; foreach($item in $bin.Items()) { if($item.ExtendedProperty('System.Recycle.DeletedFrom') -eq $env:GUIJIAN_SHELL_TEST_PARENT -and $item.Name -eq $env:GUIJIAN_SHELL_TEST_NAME) { $found=$true; break } }; if(-not $found) { throw 'Synthetic file not found in Recycle Bin' }",
        ])
        .env("GUIJIAN_SHELL_TEST_PARENT", path.parent().unwrap())
        .env("GUIJIAN_SHELL_TEST_NAME", path.file_name().unwrap())
        .output()
        .expect("start Windows PowerShell for a read-only Recycle Bin query");
    assert!(
        output.status.success(),
        "verify the synthetic file is recoverable from the Recycle Bin: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
#[ignore = "uses the real Windows Recycle Bin with synthetic files only"]
fn recycles_selected_file_and_preserves_keeper() {
    let fixture = ShellFixture::new("normal");
    let keeper = fixture.write("keep.bin", b"synthetic duplicate");
    let selected = fixture.write("selected.bin", b"synthetic duplicate");

    WindowsTrash.move_to_trash(&selected).unwrap();

    assert_recycled(&selected);
    assert_eq!(fs::read(keeper).unwrap(), b"synthetic duplicate");
}

#[test]
#[ignore = "uses the real Windows Recycle Bin with synthetic files only"]
fn occupied_file_is_not_reported_as_recycled() {
    let fixture = ShellFixture::new("occupied");
    let selected = fixture.write("occupied.bin", b"synthetic occupied file");
    let exclusive = File::options()
        .read(true)
        .share_mode(0)
        .open(&selected)
        .unwrap();

    let result = WindowsTrash.move_to_trash(&selected);

    assert!(result.is_err(), "an occupied target must report failure");
    assert!(selected.exists(), "an occupied target must remain in place");
    drop(exclusive);
    assert_eq!(fs::read(selected).unwrap(), b"synthetic occupied file");
}

#[test]
#[ignore = "uses the real Windows Recycle Bin with synthetic files only"]
fn recycling_html_preserves_unselected_associated_assets() {
    let fixture = ShellFixture::new("html");
    let page = fixture.write("page.html", b"<html>synthetic page</html>");
    let asset = fixture.write("page_files/image.png", b"synthetic image");
    let keeper = fixture.write("keep.html", b"<html>synthetic page</html>");

    WindowsTrash.move_to_trash(&page).unwrap();

    assert_recycled(&page);
    assert_eq!(fs::read(asset).unwrap(), b"synthetic image");
    assert_eq!(fs::read(keeper).unwrap(), b"<html>synthetic page</html>");
}

#[test]
#[ignore = "verifies the real Windows adapter rejects unsupported synthetic long paths"]
fn rejects_long_path_without_affecting_source_or_keeper() {
    let fixture = ShellFixture::new("long");
    let keeper = fixture.write("keep.bin", b"synthetic long-path duplicate");
    let mut relative = PathBuf::new();
    for _ in 0..4 {
        relative.push("synthetic-long-path-component-01234567890123456789");
    }
    relative.push("selected.bin");
    let selected = fixture.write(relative, b"synthetic long-path duplicate");
    assert!(selected.as_os_str().len() > 260);

    let result = WindowsTrash.move_to_trash(&selected);

    assert!(
        result.is_err(),
        "unverified long-path recycling must be refused"
    );
    assert_eq!(
        fs::read(selected).unwrap(),
        b"synthetic long-path duplicate"
    );
    assert_eq!(fs::read(keeper).unwrap(), b"synthetic long-path duplicate");
}

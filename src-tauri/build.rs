fn main() {
    // Rebuild native icon resources when the generated icon set changes.
    println!("cargo:rerun-if-changed=icons");
    tauri_build::build()
}

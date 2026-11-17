use std::io::Cursor;
use xcap::image::{codecs::jpeg::JpegEncoder, imageops, DynamicImage};
use xcap::Monitor;

/// Screenshots are downscaled to this width before upload; the model doesn't need more.
const MAX_WIDTH: u32 = 1280;

/// Capture the monitor containing (x, y) (physical desktop pixels) as a JPEG.
pub fn capture_monitor_at(x: i32, y: i32) -> Result<Vec<u8>, String> {
    let monitor = Monitor::from_point(x, y)
        .or_else(|_| {
            Monitor::all()?
                .into_iter()
                .find(|m| m.is_primary().unwrap_or(false))
                .ok_or_else(|| xcap::XCapError::new("no monitors found"))
        })
        .map_err(|e| format!("Could not find a screen to capture: {e}"))?;
    let image = monitor
        .capture_image()
        .map_err(|e| format!("Screen capture failed (on macOS, allow Screen Recording in System Settings): {e}"))?;

    let mut rgb = DynamicImage::ImageRgba8(image).to_rgb8();
    if rgb.width() > MAX_WIDTH {
        let height = (rgb.height() as f64 * MAX_WIDTH as f64 / rgb.width() as f64).round() as u32;
        rgb = imageops::resize(&rgb, MAX_WIDTH, height, imageops::FilterType::Triangle);
    }
    let mut out = Cursor::new(Vec::with_capacity(256 * 1024));
    JpegEncoder::new_with_quality(&mut out, 82)
        .encode_image(&rgb)
        .map_err(|e| format!("Could not encode screenshot: {e}"))?;
    Ok(out.into_inner())
}

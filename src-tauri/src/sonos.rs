//! Local Sonos output using the typed UPnP/SOAP and SSDP SDK crates.
//!
//! Sonos's local control interface is legacy and can be disabled in Connection
//! Security settings. The optional desktop room picker requires UPnP access.

use reqwest::blocking::Client;
use serde::Serialize;
use sonos_api::{
    SonosClient,
    operation::{ComposableOperation, UPnPOperation, ValidationError},
    services::{av_transport, rendering_control},
};
use std::{collections::HashSet, net::Ipv4Addr, time::Duration};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosPlayer {
    pub id: String,
    pub name: String,
    pub rincon_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SonosStatus {
    pub state: String,
    pub transport_status: String,
    pub position: f64,
    pub duration: f64,
}

fn client() -> Result<Client, String> {
    Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("GratefulVibes/1.0 Sonos controller")
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(|error| format!("Could not initialize Archive.org networking: {error}"))
}

pub fn discover() -> Result<Vec<SonosPlayer>, String> {
    let mut seen = HashSet::new();
    let mut players = Vec::new();

    for device in sonos_discovery::get_with_timeout(Duration::from_millis(2600)) {
        let Ok(ip) = device.ip_address.parse::<Ipv4Addr>() else {
            continue;
        };
        let id = ip.to_string();
        if !seen.insert(id.clone()) {
            continue;
        }

        let rincon_id = device
            .id
            .strip_prefix("uuid:")
            .unwrap_or(&device.id)
            .to_string();
        if !rincon_id.starts_with("RINCON_")
            || !rincon_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '_')
        {
            continue;
        }

        let room_name = device.room_name.trim();
        let name = if room_name.is_empty() || room_name.eq_ignore_ascii_case("unknown") {
            device.name
        } else {
            room_name.to_string()
        };
        players.push(SonosPlayer {
            id,
            name,
            rincon_id,
        });
    }

    players.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(players)
}

fn parse_player_id(player_id: &str) -> Result<String, String> {
    player_id
        .parse::<Ipv4Addr>()
        .map(|ip| ip.to_string())
        .map_err(|_| "Choose a Sonos speaker from the room list first.".to_string())
}

fn map_api_error(error: impl std::fmt::Display) -> String {
    let message = error.to_string();
    if message.contains("401") || message.contains("606") {
        "Sonos rejected local control. Check that UPnP is enabled in Sonos Connection Security settings.".to_string()
    } else {
        format!("Sonos could not complete the command: {message}")
    }
}

fn execute<Operation: UPnPOperation>(
    player_id: &str,
    operation: Result<ComposableOperation<Operation>, ValidationError>,
) -> Result<Operation::Response, String> {
    let ip = parse_player_id(player_id)?;
    let operation = operation.map_err(map_api_error)?;
    SonosClient::new()
        .execute_enhanced(&ip, operation)
        .map_err(map_api_error)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

pub fn play(player_id: &str, uri: &str, title: &str, artist: &str) -> Result<(), String> {
    if !uri.starts_with("https://") {
        return Err("Sonos playback requires a secure Archive.org stream URL.".to_string());
    }

    let response = client()?
        .get(uri)
        .header("Range", "bytes=0-0")
        .send()
        .map_err(|error| {
            format!("Could not reach this Archive.org audio stream. Check your internet connection and the recording's availability: {error}")
        })?;
    if !response.status().is_success() {
        return Err(format!(
            "Archive.org returned HTTP {} for this track, so Sonos cannot play it.",
            response.status()
        ));
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let is_audio = content_type.starts_with("audio/")
        || content_type.contains("octet-stream")
        || uri.to_ascii_lowercase().contains(".mp3")
        || uri.to_ascii_lowercase().contains(".ogg");
    if !is_audio {
        return Err(format!(
            "Archive.org returned an unsupported stream type ({content_type}); Sonos needs an audio stream."
        ));
    }

    let protocol = if uri.to_ascii_lowercase().contains(".ogg") {
        "audio/ogg"
    } else {
        "audio/mpeg"
    };
    let uri_xml = escape_xml(uri);
    let metadata = format!(
        "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\"><item id=\"0\" parentID=\"0\" restricted=\"true\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo=\"http-get:*:{protocol}:*\">{uri_xml}</res></item></DIDL-Lite>",
        escape_xml(title),
        escape_xml(artist),
    );

    execute(
        player_id,
        av_transport::set_av_transport_uri(uri.to_string(), metadata).build(),
    )?;
    execute(player_id, av_transport::play("1".to_string()).build())?;
    Ok(())
}

pub fn control(player_id: &str, action: &str, value: Option<String>) -> Result<(), String> {
    match action {
        "play" => execute(player_id, av_transport::play("1".to_string()).build())?,
        "pause" => execute(player_id, av_transport::pause().build())?,
        "stop" => execute(player_id, av_transport::stop().build())?,
        "seek" => {
            let seconds = value
                .and_then(|value| value.parse::<f64>().ok())
                .filter(|seconds| seconds.is_finite() && *seconds >= 0.0)
                .ok_or_else(|| "Choose a valid playback position.".to_string())?;
            execute(
                player_id,
                av_transport::seek("REL_TIME".to_string(), format_time(seconds)).build(),
            )?;
        }
        "volume" => {
            let volume = value
                .and_then(|value| value.parse::<u8>().ok())
                .filter(|volume| *volume <= 100)
                .ok_or_else(|| "Choose a volume from 0 to 100.".to_string())?;
            execute(
                player_id,
                rendering_control::set_volume("Master".to_string(), volume).build(),
            )?;
        }
        _ => return Err("Unsupported Sonos playback command.".to_string()),
    }
    Ok(())
}

pub fn join(player_id: &str, coordinator_rincon_id: &str) -> Result<(), String> {
    if !coordinator_rincon_id.starts_with("RINCON_")
        || !coordinator_rincon_id
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
    {
        return Err("Choose a valid Sonos room to group with.".to_string());
    }
    execute(
        player_id,
        av_transport::set_av_transport_uri(
            format!("x-rincon:{coordinator_rincon_id}"),
            String::new(),
        )
        .build(),
    )?;
    Ok(())
}

pub fn leave(player_id: &str) -> Result<(), String> {
    execute(
        player_id,
        av_transport::become_coordinator_of_standalone_group().build(),
    )?;
    Ok(())
}

fn format_time(seconds: f64) -> String {
    let whole = seconds.floor() as u64;
    format!(
        "{:02}:{:02}:{:02}",
        whole / 3600,
        (whole / 60) % 60,
        whole % 60
    )
}

fn parse_time(value: &str) -> f64 {
    let parts: Vec<f64> = value
        .split(':')
        .filter_map(|part| part.parse().ok())
        .collect();
    match parts.as_slice() {
        [hours, minutes, seconds] => hours * 3600.0 + minutes * 60.0 + seconds,
        _ => 0.0,
    }
}

pub fn status(player_id: &str) -> Result<SonosStatus, String> {
    let transport = execute(player_id, av_transport::get_transport_info().build())?;
    let position = execute(player_id, av_transport::get_position_info().build())?;
    Ok(SonosStatus {
        state: transport.current_transport_state,
        transport_status: transport.current_transport_status,
        position: parse_time(&position.rel_time),
        duration: parse_time(&position.track_duration),
    })
}

pub fn supported() -> bool {
    cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    ))
}

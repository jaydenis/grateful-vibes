//! Local Sonos output using the LAN UPnP interface.
//!
//! Sonos documents its cloud Control API as the supported public integration path;
//! the LAN UPnP interface used here is legacy and can be disabled in Sonos settings.

use reqwest::blocking::Client;
use serde::Serialize;
use std::{
    net::UdpSocket,
    time::{Duration, Instant},
};

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
        .map_err(|error| format!("Could not initialize local Sonos networking: {error}"))
}

fn xml_unescape(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
}

fn tag_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let start = xml.find(&format!("<{tag}"))?;
    let open_end = xml[start..].find('>')? + start + 1;
    let close = format!("</{tag}>");
    let end = xml[open_end..].find(&close)? + open_end;
    Some(&xml[open_end..end])
}

fn parse_ip(location: &str) -> Option<String> {
    let authority = location.split_once("://")?.1.split('/').next()?;
    let host = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let host = host.split(':').next()?;
    if host.parse::<std::net::Ipv4Addr>().is_ok() {
        Some(host.to_string())
    } else {
        None
    }
}

fn attribute_value<'a>(tag: &'a str, attribute: &str) -> Option<&'a str> {
    let marker = format!("{attribute}=\"");
    let start = tag.find(&marker)? + marker.len();
    let end = tag[start..].find('\"')? + start;
    Some(&tag[start..end])
}

fn room_name(zone_state: &str, rincon_id: &str) -> Option<String> {
    let zone_state = xml_unescape(zone_state);
    let mut rest = zone_state.as_str();
    while let Some(start) = rest.find("<ZoneGroup") {
        rest = &rest[start..];
        let end = rest.find("</ZoneGroup>")? + "</ZoneGroup>".len();
        let group = &rest[..end];
        if group.contains(rincon_id) {
            let mut members = group;
            while let Some(member_start) = members.find("<ZoneGroupMember") {
                members = &members[member_start..];
                let member_end = members.find('>')? + 1;
                let member = &members[..member_end];
                if member.contains(rincon_id) {
                    let name = attribute_value(member, "ZoneName")?.trim();
                    if !name.is_empty() {
                        return Some(name.to_string());
                    }
                }
                members = &members[member_end..];
            }
        }
        rest = &rest[end..];
    }
    None
}

fn sonos_room_name(http: &Client, ip: &str, rincon_id: &str) -> Option<String> {
    let service_type = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:GetZoneGroupState xmlns:u=\"{service_type}\"></u:GetZoneGroupState></s:Body></s:Envelope>"
    );
    let response = http
        .post(format!("http://{ip}:1400/ZoneGroupTopology/Control"))
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", format!("\"{service_type}#GetZoneGroupState\""))
        .body(body)
        .send()
        .ok()?
        .error_for_status()
        .ok()?
        .text()
        .ok()?;
    let state = tag_text(&response, "ZoneGroupState")?;
    room_name(state, rincon_id)
}

pub fn discover() -> Result<Vec<SonosPlayer>, String> {
    let socket = UdpSocket::bind("0.0.0.0:0").map_err(|error| {
        format!("Could not search your local network for Sonos speakers: {error}")
    })?;
    socket
        .set_read_timeout(Some(Duration::from_millis(300)))
        .map_err(|error| error.to_string())?;
    let request = concat!(
        "M-SEARCH * HTTP/1.1\r\n",
        "HOST: 239.255.255.250:1900\r\n",
        "MAN: \"ssdp:discover\"\r\n",
        "MX: 2\r\n",
        "ST: urn:schemas-upnp-org:device:ZonePlayer:1\r\n\r\n"
    );
    socket
        .send_to(request.as_bytes(), "239.255.255.250:1900")
        .map_err(|error| {
            format!("Could not search your local network for Sonos speakers: {error}")
        })?;

    let http = client()?;
    let mut players = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut buf = [0u8; 8192];
    let deadline = Instant::now() + Duration::from_millis(2600);
    loop {
        if Instant::now() >= deadline {
            break;
        }
        match socket.recv_from(&mut buf) {
            Ok((size, _)) => {
                let response = String::from_utf8_lossy(&buf[..size]);
                let location = response.lines().find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("location").then(|| value.trim())
                });
                let Some(location) = location else { continue };
                let Some(ip) = parse_ip(location) else {
                    continue;
                };
                if !seen.insert(ip.clone()) {
                    continue;
                }
                let description_url = format!("http://{ip}:1400/xml/device_description.xml");
                let Ok(description) = http
                    .get(description_url)
                    .send()
                    .and_then(|response| response.error_for_status())
                else {
                    continue;
                };
                let Ok(xml) = description.text() else {
                    continue;
                };
                let is_zone_player =
                    tag_text(&xml, "deviceType").is_some_and(|kind| kind.contains("ZonePlayer"));
                if !is_zone_player {
                    continue;
                }
                let friendly_name = tag_text(&xml, "friendlyName")
                    .map(xml_unescape)
                    .filter(|name| !name.trim().is_empty())
                    .unwrap_or_else(|| format!("Sonos speaker ({ip})"));
                let rincon_id = tag_text(&xml, "UDN")
                    .map(xml_unescape)
                    .and_then(|udn| udn.strip_prefix("uuid:").map(str::to_string))
                    .filter(|id| {
                        id.starts_with("RINCON_")
                            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
                    })
                    .ok_or_else(|| format!("Could not read the Sonos ID for {friendly_name}."))?;
                let name = sonos_room_name(&http, &ip, &rincon_id).unwrap_or(friendly_name);
                players.push(SonosPlayer {
                    id: ip,
                    name,
                    rincon_id,
                });
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                if Instant::now() >= deadline {
                    break;
                }
            }
            Err(error) => return Err(format!("Sonos discovery stopped unexpectedly: {error}")),
        }
    }
    players.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(players)
}

fn escape_xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('\"', "&quot;")
        .replace('\'', "&apos;")
}

fn soap(player_id: &str, service: &str, action: &str, args: &str) -> Result<String, String> {
    let host = player_id
        .parse::<std::net::Ipv4Addr>()
        .map_err(|_| "Choose a Sonos speaker from the room list first.".to_string())?;
    let service_type = match service {
        "AVTransport" => "urn:schemas-upnp-org:service:AVTransport:1",
        "RenderingControl" => "urn:schemas-upnp-org:service:RenderingControl:1",
        _ => return Err("Unsupported Sonos service.".to_string()),
    };
    let url = format!("http://{host}:1400/MediaRenderer/{service}/Control");
    let body = format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?><s:Envelope xmlns:s=\"http://schemas.xmlsoap.org/soap/envelope/\" s:encodingStyle=\"http://schemas.xmlsoap.org/soap/encoding/\"><s:Body><u:{action} xmlns:u=\"{service_type}\">{args}</u:{action}></s:Body></s:Envelope>"
    );
    let response = client()?
        .post(url)
        .header("Content-Type", "text/xml; charset=\"utf-8\"")
        .header("SOAPACTION", format!("\"{service_type}#{action}\""))
        .body(body)
        .send()
        .map_err(|error| {
            format!(
                "Could not reach this Sonos speaker. Check that it is on the same network: {error}"
            )
        })?;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    if !status.is_success() {
        let code = tag_text(&text, "errorCode").unwrap_or("");
        return Err(if code == "401" || code == "606" {
            "Sonos rejected local control. Check that UPnP is enabled in Sonos Connection Security settings.".to_string()
        } else {
            format!(
                "Sonos could not complete {action} (HTTP {status}). Check UPnP access and try again."
            )
        });
    }
    Ok(text)
}

pub fn play(player_id: &str, uri: &str, title: &str, artist: &str) -> Result<(), String> {
    if !uri.starts_with("https://") {
        return Err("Sonos playback requires a secure Archive.org stream URL.".to_string());
    }
    let response = client()?.get(uri).header("Range", "bytes=0-0").send()
        .map_err(|error| format!("Could not reach this Archive.org audio stream. Check your internet connection and the recording's availability: {error}"))?;
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
    let title_xml = escape_xml(title);
    let artist_xml = escape_xml(artist);
    let metadata = format!(
        "<DIDL-Lite xmlns:dc=\"http://purl.org/dc/elements/1.1/\" xmlns:upnp=\"urn:schemas-upnp-org:metadata-1-0/upnp/\" xmlns=\"urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/\"><item id=\"0\" parentID=\"0\" restricted=\"true\"><dc:title>{title_xml}</dc:title><dc:creator>{artist_xml}</dc:creator><upnp:class>object.item.audioItem.musicTrack</upnp:class><res protocolInfo=\"http-get:*:{protocol}:*\">{uri_xml}</res></item></DIDL-Lite>"
    );
    let metadata_xml = escape_xml(&metadata);
    soap(
        player_id,
        "AVTransport",
        "SetAVTransportURI",
        &format!(
            "<InstanceID>0</InstanceID><CurrentURI>{uri_xml}</CurrentURI><CurrentURIMetaData>{metadata_xml}</CurrentURIMetaData>"
        ),
    )?;
    soap(
        player_id,
        "AVTransport",
        "Play",
        "<InstanceID>0</InstanceID><Speed>1</Speed>",
    )?;
    Ok(())
}

pub fn control(player_id: &str, action: &str, value: Option<String>) -> Result<(), String> {
    match action {
        "play" | "pause" | "stop" => {
            soap(
                player_id,
                "AVTransport",
                &capitalize(action),
                "<InstanceID>0</InstanceID><Speed>1</Speed>",
            )?;
        }
        "seek" => {
            let seconds = value
                .and_then(|v| v.parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.0)
                .ok_or_else(|| "Choose a valid playback position.".to_string())?;
            soap(
                player_id,
                "AVTransport",
                "Seek",
                &format!(
                    "<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>{}</Target>",
                    format_time(seconds)
                ),
            )?;
        }
        "volume" => {
            let volume = value
                .and_then(|v| v.parse::<u8>().ok())
                .filter(|v| *v <= 100)
                .ok_or_else(|| "Choose a volume from 0 to 100.".to_string())?;
            soap(
                player_id,
                "RenderingControl",
                "SetVolume",
                &format!(
                    "<InstanceID>0</InstanceID><Channel>Master</Channel><DesiredVolume>{volume}</DesiredVolume>"
                ),
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
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err("Choose a valid Sonos room to group with.".to_string());
    }
    soap(
        player_id,
        "AVTransport",
        "SetAVTransportURI",
        &format!(
            "<InstanceID>0</InstanceID><CurrentURI>x-rincon:{coordinator_rincon_id}</CurrentURI><CurrentURIMetaData></CurrentURIMetaData>"
        ),
    )?;
    Ok(())
}

pub fn leave(player_id: &str) -> Result<(), String> {
    soap(
        player_id,
        "AVTransport",
        "BecomeCoordinatorOfStandaloneGroup",
        "<InstanceID>0</InstanceID>",
    )?;
    Ok(())
}

fn capitalize(action: &str) -> String {
    let mut chars = action.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().collect::<String>() + chars.as_str())
        .unwrap_or_default()
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
    let transport = soap(
        player_id,
        "AVTransport",
        "GetTransportInfo",
        "<InstanceID>0</InstanceID>",
    )?;
    let position = soap(
        player_id,
        "AVTransport",
        "GetPositionInfo",
        "<InstanceID>0</InstanceID>",
    )?;
    Ok(SonosStatus {
        state: tag_text(&transport, "CurrentTransportState")
            .map(xml_unescape)
            .unwrap_or_else(|| "STOPPED".into()),
        transport_status: tag_text(&transport, "CurrentTransportStatus")
            .map(xml_unescape)
            .unwrap_or_else(|| "OK".into()),
        position: tag_text(&position, "RelTime")
            .map(parse_time)
            .unwrap_or(0.0),
        duration: tag_text(&position, "TrackDuration")
            .map(parse_time)
            .unwrap_or(0.0),
    })
}

pub fn supported() -> bool {
    cfg!(any(
        target_os = "windows",
        target_os = "macos",
        target_os = "linux"
    ))
}

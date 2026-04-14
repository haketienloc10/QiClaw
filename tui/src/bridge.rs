use std::fs::File;
use std::io::{self, BufRead, BufReader, BufWriter, Write};

use crate::protocol::{parse_host_event_line, serialize_frontend_action, FrontendAction, HostEvent};

pub struct HostEventReader {
    reader: BufReader<File>,
}

pub struct ActionWriter {
    writer: BufWriter<File>,
}

pub struct NdjsonBridge {
    reader: HostEventReader,
    writer: ActionWriter,
}

impl NdjsonBridge {
    pub fn new() -> io::Result<Self> {
        Self::from_fds(3, 4)
    }

    pub fn from_fds(read_fd: i32, write_fd: i32) -> io::Result<Self> {
        #[cfg(unix)]
        {
            use std::os::fd::FromRawFd;

            let reader = unsafe { File::from_raw_fd(read_fd) };
            let writer = unsafe { File::from_raw_fd(write_fd) };
            Ok(Self {
                reader: HostEventReader {
                    reader: BufReader::new(reader),
                },
                writer: ActionWriter {
                    writer: BufWriter::new(writer),
                },
            })
        }
        #[cfg(not(unix))]
        {
            let _ = (read_fd, write_fd);
            Err(io::Error::new(
                io::ErrorKind::Unsupported,
                "qiclaw-tui currently requires unix fd 3/4 bridge support",
            ))
        }
    }

    pub fn split(self) -> (HostEventReader, ActionWriter) {
        (self.reader, self.writer)
    }
}

impl HostEventReader {
    pub fn read_event(&mut self) -> io::Result<Option<HostEvent>> {
        loop {
            let mut line = String::new();
            let read = self.reader.read_line(&mut line)?;
            if read == 0 {
                return Ok(None);
            }
            if line.trim().is_empty() {
                continue;
            }
            return parse_host_event_line(&line)
                .map(Some)
                .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
        }
    }
}

impl ActionWriter {
    pub fn send_action(&mut self, action: &FrontendAction) -> io::Result<()> {
        let line = serialize_frontend_action(action)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        self.writer.write_all(line.as_bytes())?;
        self.writer.flush()
    }
}

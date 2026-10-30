//! When a reminder is due: an ISO 8601 date-time with an explicit offset.
//!
//! Nothing relative ("in 2h", "tomorrow 09:00"): what "tomorrow" means
//! depends on a clock and a time zone this process would have to guess, and a
//! wrong guess is a reminder at the wrong hour that nobody notices until it
//! is late. The agent can run `date` and do the arithmetic itself; the tool
//! description says so. No date crate either: the format is small enough to
//! read by hand, and every case is a test below.

/// Milliseconds since the Unix epoch for `s`, or a sentence saying what is wrong.
///
/// Accepts `YYYY-MM-DDTHH:MM[:SS[.fraction]]` followed by `Z` or an offset
/// (`+01:00`, `-0530`). A lowercase `t`/`z` is accepted too, as RFC 3339 allows.
pub fn parse_due(s: &str) -> Result<i64, String> {
    let bad = || {
        format!(
            "`due` must be an ISO 8601 date-time with a UTC offset, such as 2026-11-03T09:00:00+01:00 \
             or 2026-11-03T08:00:00Z (got {s:?}). Relative times are not accepted: run `date` for the \
             current time and offset, and compute the date-time yourself."
        )
    };
    let b = s.trim().as_bytes();
    if b.len() < 17 {
        return Err(bad());
    }
    let num = |from: usize, len: usize| -> Option<i64> {
        let part = b.get(from..from + len)?;
        if !part.iter().all(u8::is_ascii_digit) {
            return None;
        }
        std::str::from_utf8(part).ok()?.parse().ok()
    };
    let year = num(0, 4).ok_or_else(bad)?;
    if b[4] != b'-' || b[7] != b'-' || !matches!(b[10], b'T' | b't') || b[13] != b':' {
        return Err(bad());
    }
    let month = num(5, 2).ok_or_else(bad)?;
    let day = num(8, 2).ok_or_else(bad)?;
    let hour = num(11, 2).ok_or_else(bad)?;
    let minute = num(14, 2).ok_or_else(bad)?;
    let mut i = 16;
    let mut second = 0;
    let mut millis = 0;
    if b.get(i) == Some(&b':') {
        second = num(i + 1, 2).ok_or_else(bad)?;
        i += 3;
        if b.get(i) == Some(&b'.') {
            i += 1;
            let start = i;
            while b.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
            if i == start {
                return Err(bad());
            }
            // Milliseconds from the first three digits; the rest is below
            // anything a reminder can mean.
            let digits = &b[start..i.min(start + 3)];
            let mut ms = 0;
            for (k, d) in digits.iter().enumerate() {
                ms += i64::from(d - b'0') * [100, 10, 1][k];
            }
            millis = ms;
        }
    }
    let offset_min = match b.get(i) {
        Some(b'Z' | b'z') if i + 1 == b.len() => 0,
        Some(sign @ (b'+' | b'-')) => {
            let oh = num(i + 1, 2).ok_or_else(bad)?;
            let rest = &b[i + 3..];
            let om = match rest {
                [b':', ..] if rest.len() == 3 => num(i + 4, 2).ok_or_else(bad)?,
                _ if rest.len() == 2 => num(i + 3, 2).ok_or_else(bad)?,
                _ => return Err(bad()),
            };
            if oh > 14 || om > 59 {
                return Err(bad());
            }
            let m = oh * 60 + om;
            if *sign == b'-' {
                -m
            } else {
                m
            }
        }
        _ => {
            return Err(format!(
                "`due` needs a UTC offset or Z: {s:?} names no time zone, so it could mean any of 24 hours. \
                 Add yours, e.g. +01:00 (`date +%z` prints it)."
            ))
        }
    };
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(bad());
    }
    let days = days_from_civil(year, month, day);
    let local = ((days * 24 + hour) * 60 + minute) * 60 + second;
    Ok((local - offset_min * 60) * 1000 + millis)
}

fn is_leap(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: i64) -> i64 {
    match m {
        2 if is_leap(y) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 for a proleptic Gregorian date (Howard Hinnant's
/// `days_from_civil`).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utc_and_offsets_land_on_the_same_instant() {
        let z = parse_due("2026-11-03T08:00:00Z").unwrap();
        assert_eq!(z, 1_793_692_800_000);
        assert_eq!(parse_due("2026-11-03T09:00:00+01:00").unwrap(), z);
        assert_eq!(parse_due("2026-11-03T03:00:00-0500").unwrap(), z);
        assert_eq!(parse_due("2026-11-03T08:00Z").unwrap(), z);
        assert_eq!(parse_due("2026-11-03t08:00:00z").unwrap(), z);
    }

    #[test]
    fn the_epoch_is_zero_and_fractions_are_milliseconds() {
        assert_eq!(parse_due("1970-01-01T00:00:00Z").unwrap(), 0);
        assert_eq!(parse_due("1970-01-01T00:00:01.25Z").unwrap(), 1_250);
        assert_eq!(parse_due("1970-01-01T00:00:00.123456+00:00").unwrap(), 123);
    }

    #[test]
    fn leap_days_are_real_only_in_leap_years() {
        assert!(parse_due("2028-02-29T10:00:00Z").is_ok());
        assert!(parse_due("2027-02-29T10:00:00Z").is_err());
        assert!(parse_due("2100-02-29T10:00:00Z").is_err());
        assert!(parse_due("2000-02-29T10:00:00Z").is_ok());
    }

    #[test]
    fn no_offset_is_refused_with_a_reason() {
        let err = parse_due("2026-11-03T09:00:00").unwrap_err();
        assert!(err.contains("UTC offset"), "{err}");
    }

    #[test]
    fn relative_and_malformed_times_are_refused() {
        for s in [
            "in 2h",
            "tomorrow 09:00",
            "2026-11-03",
            "2026-13-03T09:00:00Z",
            "2026-11-31T09:00:00Z",
            "2026-11-03T24:00:00Z",
            "2026-11-03T09:60:00Z",
            "2026-11-03T09:00:00+15:00",
            "2026-11-03T09:00:00+01:00junk",
            "2026-11-03T09:00:00.Z",
            "2026-11-03 09:00:00Z",
            "",
        ] {
            assert!(parse_due(s).is_err(), "{s} should be refused");
        }
    }
}

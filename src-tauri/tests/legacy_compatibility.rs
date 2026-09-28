use ni_clock_in_lib::{exchange, store::Store};
use std::path::Path;

/// Run explicitly against a local legacy checkout; personal records are never committed as fixtures.
#[test]
#[ignore = "requires NI_CLOCK_LEGACY_DIR pointing to the legacy data directory"]
fn migrate_real_legacy_configuration_and_report() {
    let directory = std::env::var("NI_CLOCK_LEGACY_DIR").expect("NI_CLOCK_LEGACY_DIR");
    let backup = exchange::read_legacy(Path::new(&directory)).unwrap();
    let people = backup.config.people.len();
    let shifts = backup.config.shifts.len();
    assert!(people > 0 && shifts > 0);
    let temp = tempfile::tempdir().unwrap();
    let mut store = Store::open(temp.path()).unwrap();
    store.install_backup(backup, false).unwrap();
    let boot = store.bootstrap().unwrap();
    assert_eq!(
        (boot.config.people.len(), boot.config.shifts.len()),
        (people, shifts)
    );
    let result = store.calculate(&boot.config.query, &[]).unwrap();
    assert!(!result.rows.is_empty());
    if let Ok(report) = std::env::var("NI_CLOCK_LEGACY_REPORT") {
        let rows = exchange::merge_monthly(&[report]).unwrap();
        assert!(!rows.is_empty());
        let output = temp.path().join("converted.xlsx");
        exchange::export_statistics(&output, &rows, &[], Some(&boot.config.query), "period")
            .unwrap();
        assert_eq!(
            exchange::merge_monthly(&[output.to_string_lossy().into()])
                .unwrap()
                .len(),
            rows.len()
        );
    }
}

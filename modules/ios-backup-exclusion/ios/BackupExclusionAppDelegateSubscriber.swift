import ExpoModulesCore

/**
 Keeps app storage out of iCloud and iTunes backups (SECURITY-AUDIT.md, M4).

 Recovery phrases and group keys live in the keychain, marked device-only, so
 they never leave the phone. App storage is another matter: AsyncStorage keeps
 group records, chat, wallet descriptors and xpubs, unsent messages and the
 decoy inbox as plain files, and iOS backs those up unless each file or its
 directory says otherwise. Android has `allowBackup=false` for the same
 reason; iOS has no such switch, only the per-item attribute set here.

 Runs before any JavaScript, at every launch, so the attribute is on the
 directory before AsyncStorage writes its first file — a directory marked
 excluded excludes everything created inside it.
 */
public class BackupExclusionAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    BackupExclusion.excludeAppStorage()
    return true
  }
}

enum BackupExclusion {
  /// AsyncStorage's directory name on iOS, under both of the parents it has used.
  private static let asyncStorageDirectory = "RCTAsyncLocalStorage_V1"

  static func excludeAppStorage() {
    let fileManager = FileManager.default
    let bundleId = Bundle.main.bundleIdentifier ?? ""

    // Where AsyncStorage writes today: Application Support/<bundle id>/RCTAsyncLocalStorage_V1.
    // The parent is marked, and created first if this is the first launch, so
    // nothing AsyncStorage puts there is ever eligible for a backup.
    if let support = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first, !bundleId.isEmpty {
      exclude(support.appendingPathComponent(bundleId, isDirectory: true), createIfMissing: true)
    }
    // Where builds before the move wrote, still read for migration.
    if let documents = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first {
      exclude(documents.appendingPathComponent(asyncStorageDirectory, isDirectory: true), createIfMissing: false)
    }
  }

  private static func exclude(_ directory: URL, createIfMissing: Bool) {
    let fileManager = FileManager.default
    if !fileManager.fileExists(atPath: directory.path) {
      guard createIfMissing else { return }
      do {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
      } catch {
        NSLog("[backup-exclusion] could not create %@: %@", directory.path, error.localizedDescription)
        return
      }
    }
    var url = directory
    var values = URLResourceValues()
    values.isExcludedFromBackup = true
    do {
      try url.setResourceValues(values)
    } catch {
      NSLog("[backup-exclusion] could not exclude %@ from backup: %@", directory.path, error.localizedDescription)
    }
  }
}

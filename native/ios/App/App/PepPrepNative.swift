import Foundation
import Capacitor

/// Hosts the web app and registers the app's own plugin (see SceneDelegate).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ICloudBackupPlugin())
    }
}

/// Saves backup files to the app's iCloud Drive folder (Files > iCloud Drive > Pep Prep),
/// or to the app's own Documents folder (Files > On My iPhone > Pep Prep) when iCloud Drive is off.
/// Keeps the newest 8 automatic backups.
@objc(ICloudBackupPlugin)
public class ICloudBackupPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ICloudBackupPlugin"
    public let jsName = "ICloudBackup"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "save", returnType: CAPPluginReturnPromise)
    ]

    @objc func save(_ call: CAPPluginCall) {
        guard let name = call.getString("name"), let text = call.getString("text") else {
            call.reject("name and text are required")
            return
        }
        let fileName = (name as NSString).lastPathComponent
        DispatchQueue.global(qos: .utility).async {
            let fm = FileManager.default
            var location = "local"
            var dir = fm.urls(for: .documentDirectory, in: .userDomainMask)[0]
            if let container = fm.url(forUbiquityContainerIdentifier: nil) {
                dir = container.appendingPathComponent("Documents", isDirectory: true)
                location = "icloud"
            }
            do {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
                let url = dir.appendingPathComponent(fileName)
                try text.write(to: url, atomically: true, encoding: .utf8)
                let files = (try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
                let backups = files
                    .filter { $0.lastPathComponent.hasPrefix("pep-prep-auto-") }
                    .sorted { $0.lastPathComponent > $1.lastPathComponent }
                for old in backups.dropFirst(8) { try? fm.removeItem(at: old) }
                call.resolve(["location": location, "path": url.path])
            } catch {
                call.reject("Couldn't save the backup: \(error.localizedDescription)")
            }
        }
    }
}

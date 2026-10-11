require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', '..', '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'BackupExclusion'
  s.version        = package['version']
  s.summary        = 'Keeps app storage out of iCloud and iTunes backups.'
  s.description    = 'Marks the directories AsyncStorage uses as excluded from backup when the app launches (SECURITY-AUDIT.md, M4).'
  s.license        = package['license'] || 'UNLICENSED'
  s.author         = package['author'] || ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end

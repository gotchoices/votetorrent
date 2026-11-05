require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

Pod::Spec.new do |s|
  s.name         = 'AttestationNative'
  s.version      = package['version']
  s.summary      = package['description']
  s.license      = package['license']
  s.authors      = { 'VoteTorrent' => 'https://github.com/gotchoices/votetorrent' }
  s.homepage     = 'https://github.com/gotchoices/votetorrent'
  s.platforms    = { :ios => '15.1' }
  s.source       = { :git => 'https://github.com/gotchoices/votetorrent.git', :tag => s.version.to_s }

  # Swift implementation + the RCT_EXTERN_MODULE registration shim that makes it visible to
  # `TurboModuleRegistry.getEnforcing('AttestationNative')`. Without the .m the Swift class is
  # compiled but never registered, and the module resolves to undefined at runtime.
  s.source_files = 'ios/**/*.{swift,h,m,mm}'

  # DCAppAttestService (App Attest) + Secure Enclave key creation.
  s.frameworks   = 'DeviceCheck', 'LocalAuthentication', 'Security', 'CryptoKit'

  s.dependency 'React-Core'
end

package org.votetorrent.attestationnative

import com.facebook.react.TurboReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.module.model.ReactModuleInfo
import com.facebook.react.module.model.ReactModuleInfoProvider

class AttestationNativePackage : TurboReactPackage() {

	override fun getModule(name: String, reactContext: ReactApplicationContext): NativeModule? {
		return when (name) {
			AttestationNativeModule.NAME -> AttestationNativeModule(reactContext)
			else -> null
		}
	}

	override fun getReactModuleInfoProvider(): ReactModuleInfoProvider {
		return ReactModuleInfoProvider {
			val moduleInfos: MutableMap<String, ReactModuleInfo> = HashMap()
			val isTurboModule = BuildConfig.IS_NEW_ARCHITECTURE_ENABLED

			val moduleInfo = ReactModuleInfo(
				AttestationNativeModule.NAME,
				AttestationNativeModule.NAME,
				false,
				true,
				false,
				isTurboModule,
			)

			moduleInfos[AttestationNativeModule.NAME] = moduleInfo
			moduleInfos
		}
	}
}

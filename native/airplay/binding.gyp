{
  "targets": [
    {
      "target_name": "airplay",
      "sources": [ "airplay_addon.mm" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")"
      ],
      "libraries": [
        "-framework AppKit",
        "-framework AVFoundation",
        "-framework AVKit",
        "-framework CoreMedia"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS" ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_ENABLE_OBJC_ARC": "YES",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_CPLUSPLUSFLAGS": [ "-fexceptions", "-ObjC++" ]
      }
    }
  ]
}

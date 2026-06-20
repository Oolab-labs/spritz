{
  "targets": [
    {
      "target_name": "mpv_render",
      "sources": [ "mpv_addon.mm" ],
      "include_dirs": [
        "<!@(node -p \"require('node-addon-api').include\")",
        "/opt/homebrew/opt/mpv/include"
      ],
      "libraries": [
        "-L/opt/homebrew/opt/mpv/lib",
        "-lmpv",
        "-Wl,-rpath,/opt/homebrew/opt/mpv/lib",
        "-framework Cocoa",
        "-framework QuartzCore",
        "-framework OpenGL",
        "-framework CoreVideo",
        "-framework IOSurface"
      ],
      "defines": [ "NAPI_CPP_EXCEPTIONS", "GL_SILENCE_DEPRECATION" ],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "CLANG_ENABLE_OBJC_ARC": "NO",
        "MACOSX_DEPLOYMENT_TARGET": "12.0",
        "GCC_ENABLE_CPP_EXCEPTIONS": "YES",
        "OTHER_CPLUSPLUSFLAGS": [ "-fexceptions", "-ObjC++" ]
      }
    }
  ]
}

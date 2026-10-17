#import <AppKit/AppKit.h>
void tether_register_identity(void) {
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    NSString *icon = [[NSBundle mainBundle] pathForResource:@"tether" ofType:@"icns"];
    if (icon) [NSApp setApplicationIconImage:[[NSImage alloc] initWithContentsOfFile:icon]];
    [NSApp finishLaunching];
  }
}

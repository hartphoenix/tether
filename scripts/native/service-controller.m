#import <AppKit/AppKit.h>
#import <ServiceManagement/ServiceManagement.h>
#include <unistd.h>
#include <string.h>

int main(int argc, char **argv) {
  // exec preserves launchd's PID and signal handling while following the current runtime.
  if (argc >= 3 && strcmp(argv[1], "--launch") == 0) {
    execv(argv[2], &argv[2]);
    perror("tether service launch");
    return 1;
  }
  if (argc != 4 || strcmp(argv[1], "--service") != 0) return 64;
  @autoreleasepool {
    [NSApplication sharedApplication];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyProhibited];
    SMAppService *service = [SMAppService agentServiceWithPlistName:[NSString stringWithUTF8String:argv[2]]];
    NSError *error = nil;
    BOOL ok = YES;
    if (strcmp(argv[3], "register") == 0 && (service.status == SMAppServiceStatusNotRegistered || service.status == SMAppServiceStatusNotFound))
      ok = [service registerAndReturnError:&error];
    else if (strcmp(argv[3], "unregister") == 0 && service.status != SMAppServiceStatusNotRegistered && service.status != SMAppServiceStatusNotFound)
      ok = [service unregisterAndReturnError:&error];
    else if (strcmp(argv[3], "status") != 0 && strcmp(argv[3], "register") != 0 && strcmp(argv[3], "unregister") != 0) return 64;
    if (!ok) {
      fprintf(stderr, "%s (%ld): %s\n", error.domain.UTF8String, (long)error.code, error.localizedDescription.UTF8String);
      return 1;
    }
    printf("%ld\n", (long)service.status);
    return 0;
  }
}

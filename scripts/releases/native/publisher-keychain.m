#import <Foundation/Foundation.h>
#import <Security/Security.h>
#include <unistd.h>

// User-run helper: it never prints item contents or accepts them in arguments.
static NSString *const service = @"com.hartphoenix.tether.publisher";
static NSString *const account = @"publisher";
static NSMutableDictionary *query(void) {
    return [@{(__bridge id)kSecClass:(__bridge id)kSecClassGenericPassword,
              (__bridge id)kSecAttrService:service, (__bridge id)kSecAttrAccount:account} mutableCopy];
}
static BOOL valid(NSData *data) {
    if (!data || data.length > 32768) return NO;
    id object = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
    return [object isKindOfClass:NSDictionary.class] && [object[@"format"] isEqual:@1]
        && [object[@"purpose"] isEqual:@"tether-publisher"]
        && [object[@"privateKey"] isKindOfClass:NSString.class]
        && [object[@"privateKey"] hasPrefix:@"-----BEGIN PRIVATE KEY-----\n"];
}
static int error(NSString *message, OSStatus status) {
    fprintf(stderr, "%s (status %d)\n", message.UTF8String, (int)status); return 1;
}
int main(int argc, const char *argv[]) { @autoreleasepool {
    if (argc == 2 && strcmp(argv[1],"exists") == 0) {
        NSMutableDictionary *q=query(); q[(__bridge id)kSecReturnAttributes]=@YES;
        q[(__bridge id)kSecUseAuthenticationUI]=(__bridge id)kSecUseAuthenticationUIFail;
        OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)q,NULL);
        if(status==errSecSuccess) return 0;
        if(status==errSecItemNotFound) return 3;
        return error(@"Cannot inspect publisher item; stopped",status);
    }
    if (argc == 2 && strcmp(argv[1],"create") == 0) {
        // Read at most one bounded item, directly from the parent process pipe.
        NSMutableData *data=[NSMutableData data]; unsigned char buffer[4096]; ssize_t count;
        while((count=read(STDIN_FILENO,buffer,sizeof(buffer)))>0) {
            if(data.length+(NSUInteger)count>32768) return error(@"Publisher input exceeds limit",1);
            [data appendBytes:buffer length:(NSUInteger)count];
        }
        memset_s(buffer,sizeof(buffer),0,sizeof(buffer));
        if(count<0 || !valid(data)) return error(@"Invalid publisher input",1);
        SecAccessRef access=NULL;
        // Empty list means no application has silent access, including this helper.
        OSStatus status=SecAccessCreate(CFSTR("Tether publisher"),(__bridge CFArrayRef)@[],&access);
        if(status!=errSecSuccess) return error(@"Cannot create Keychain access policy",status);
        NSMutableDictionary *q=query(); q[(__bridge id)kSecAttrLabel]=@"Tether publisher";
        q[(__bridge id)kSecAttrAccess]=(__bridge id)access;
        q[(__bridge id)kSecValueData]=data;
        status=SecItemAdd((__bridge CFDictionaryRef)q,NULL);
        [data resetBytesInRange:NSMakeRange(0,data.length)]; CFRelease(access);
        if(status!=errSecSuccess) return error(@"Creation failed; existing item was not overwritten",status);
        puts("Publisher item created in Keychain."); return 0;
    }
    if(argc>=4 && strcmp(argv[1],"launch")==0 && strcmp(argv[2],"--")==0 && argv[3][0]=='/') {
        NSMutableDictionary *q=query(); q[(__bridge id)kSecReturnData]=@YES;
        q[(__bridge id)kSecMatchLimit]=(__bridge id)kSecMatchLimitOne;
        q[(__bridge id)kSecUseOperationPrompt]=@"Authorize Tether publisher access for this agent session";
        CFTypeRef result=NULL; OSStatus status=SecItemCopyMatching((__bridge CFDictionaryRef)q,&result);
        if(status!=errSecSuccess) return error(@"Publisher access failed or was cancelled",status);
        NSData *data=CFBridgingRelease(result);
        if(!valid(data)) return error(@"Invalid publisher item",1);
        NSString *text=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
        if(!text || setenv("TETHER_PUBLISHER_DOCUMENT",text.UTF8String,1)!=0) return error(@"Cannot prepare publisher environment",1);
        execv(argv[3],(char *const *)&argv[3]);
        unsetenv("TETHER_PUBLISHER_DOCUMENT");
        return error(@"Cannot start agent",errno);
    }
    fprintf(stderr,"Usage: publisher-keychain exists | create (stdin) | launch -- /absolute/program [arguments]\n");
    return 2;
}}

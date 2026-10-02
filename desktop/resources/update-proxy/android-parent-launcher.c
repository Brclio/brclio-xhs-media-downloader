// Keep the update transport process tied to its Android application owner.
// execv preserves the process ID and PR_SET_PDEATHSIG across the core launch.
#include <signal.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <unistd.h>

int main(int argc, char **argv) {
    if (argc < 2 || argv[1][0] != '/') return 64;
    pid_t parent = getppid();
    if (parent <= 1) return 70;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) != 0) return 71;
    // Cover the race where the owner exits before the parent-death hook is set.
    if (getppid() != parent) return 70;
    execv(argv[1], argv + 1);
    return 127;
}

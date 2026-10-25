#!/usr/bin/env python3
"""Copy allowlisted evidence files from an audit agent's scratch/ into its artifacts/ (security-audit skill, SKILL.md
"Write isolation"). Run by the parent only, after the sandbox and every process in it have exited.

usage: promote.py <agent-root> <per-file-bytes> <total-bytes> <relative-path>...
<agent-root> holds scratch/ and artifacts/. Each path is relative to scratch/ and lands at the same place in artifacts/.
Exit 0 = every file promoted; 1 = at least one refused (reason on stderr, nothing partial is left for that file).
"""
import os
import stat
import sys

DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC


def parts_of(rel):
    if not rel or rel.startswith("/") or "\\" in rel or "\0" in rel:
        raise ValueError("path must be a non-empty relative path")
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts):
        raise ValueError("path has an empty, '.' or '..' component")
    return parts


def walk(root_fd, dirs, create):
    """Open each directory below root_fd without following links; create missing ones exclusively when asked."""
    fd = os.dup(root_fd)
    try:
        for name in dirs:
            if create:
                try:
                    os.mkdir(name, 0o700, dir_fd=fd)
                except FileExistsError:
                    pass
            nxt = os.open(name, DIR_FLAGS, dir_fd=fd)  # O_NOFOLLOW: a symlinked component fails here
            os.close(fd)
            fd = nxt
            if not stat.S_ISDIR(os.fstat(fd).st_mode):
                raise ValueError(f"{name} is not a directory")
        return fd
    except BaseException:
        os.close(fd)
        raise


def promote_one(src_root, dst_root, rel, per_file, budget):
    parts = parts_of(rel)
    sdir = walk(src_root, parts[:-1], create=False)
    try:
        src = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=sdir)
    finally:
        os.close(sdir)
    try:
        st = os.fstat(src)
        if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
            raise ValueError("not a regular file with exactly one link")
        if st.st_size > per_file or st.st_size > budget:
            raise ValueError(f"size {st.st_size} over the limit")
        data = b""
        while len(data) <= st.st_size:
            chunk = os.read(src, min(65536, st.st_size + 1 - len(data)))
            if not chunk:
                break
            data += chunk
        again = os.fstat(src)
        if len(data) != st.st_size or (again.st_ino, again.st_dev, again.st_mode, again.st_nlink, again.st_size) != (
            st.st_ino, st.st_dev, st.st_mode, st.st_nlink, st.st_size
        ):
            raise ValueError("file changed while it was read")
    finally:
        os.close(src)
    ddir = walk(dst_root, parts[:-1], create=True)
    try:
        dst = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=ddir)
        try:
            dst_st = os.fstat(dst)
            if not stat.S_ISREG(dst_st.st_mode) or dst_st.st_nlink != 1:
                raise ValueError("destination is not a fresh regular file")
            view = memoryview(data)
            while view:
                view = view[os.write(dst, view):]
        except BaseException:
            os.close(dst)
            os.unlink(parts[-1], dir_fd=ddir)
            raise
        os.close(dst)
    finally:
        os.close(ddir)
    return len(data)


def main(argv):
    if len(argv) < 5:
        print(__doc__, file=sys.stderr)
        return 2
    root, per_file, total, rels = argv[1], int(argv[2]), int(argv[3]), argv[4:]
    root_fd = os.open(root, DIR_FLAGS)
    src_root = os.open("scratch", DIR_FLAGS, dir_fd=root_fd)
    try:
        os.mkdir("artifacts", 0o700, dir_fd=root_fd)
    except FileExistsError:
        pass
    dst_root = os.open("artifacts", DIR_FLAGS, dir_fd=root_fd)
    failed = 0
    for rel in rels:
        try:
            size = promote_one(src_root, dst_root, rel, per_file, total)
            total -= size
            print(f"promoted {rel} ({size} bytes)")
        except (OSError, ValueError) as e:
            failed += 1
            print(f"REFUSED {rel}: {e}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))

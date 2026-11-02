"""Keep a test from leaking changes to a module's globals into later tests."""


def restore_after(test, module):
    """Snapshot `module`'s globals now and put them back when `test` finishes.

    On a Windows host vivarc.main() runs windows_support.configure() on the shared module, which rebinds
    keys and adapters for every later test. Call this first in setUp, so it is the last cleanup to run.
    Shallow: it relies on configure() rebinding names, not mutating the objects they point to.
    """
    saved = dict(vars(module))

    def restore():
        for name in set(vars(module)) - set(saved):
            delattr(module, name)
        vars(module).update(saved)

    test.addCleanup(restore)

.class public Lfixture/Views;
.super Ljava/lang/Object;

# android:id/title as a findViewById-style constant load.
.method public static lookup()I
    .registers 1
    const v0, 0x01020016
    return v0
.end method

# Click dispatch on getId(): a packed switch over title/summary-adjacent ids
# and a sparse switch over android:id/title and android:id/icon.
.method public static dispatch(I)I
    .registers 2
    packed-switch p0, :packed
    sparse-switch p0, :sparse
    const/4 v0, 0x0
    return v0
    :one
    const/4 v0, 0x1
    return v0
    :two
    const/4 v0, 0x2
    return v0
    :packed
    .packed-switch 0x01020015
        :one
        :two
    .end packed-switch
    :sparse
    .sparse-switch
        0x01020006 -> :one
        0x01020016 -> :two
    .end sparse-switch
.end method

# A library module reads its non-final R field instead of an inlined constant.
.method public static libraryRead()I
    .registers 1
    sget v0, Lfixture/lib/R$id;->button:I
    return v0
.end method

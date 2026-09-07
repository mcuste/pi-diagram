/** Pi wraps every renderer output in this and invalidates the child unguarded. */
export class HostRegion {
  constructor(child) {
    this.child = child;
  }

  render(width) {
    return this.child.render(width);
  }

  invalidate() {
    this.child.invalidate();
  }
}

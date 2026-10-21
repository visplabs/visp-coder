class ApiError(Exception):
    """An error with its HTTP status and contract error code."""

    def __init__(self, status, code):
        super().__init__(code)
        self.status = status
        self.code = code

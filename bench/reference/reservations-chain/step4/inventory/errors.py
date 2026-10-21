class ApiError(Exception):
    """An error with its HTTP status, contract error code and, for invalid input, the rejected field."""

    def __init__(self, status, code, field=None):
        super().__init__(code)
        self.status = status
        self.code = code
        self.field = field

    def body(self):
        text = self.code.replace("_", " ")
        error = {"code": self.code, "status": self.status, "detail": text, "message": text}
        if self.field is not None:
            error["field"] = self.field
        return {"error": error}

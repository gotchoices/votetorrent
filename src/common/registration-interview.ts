export interface InterviewQuestion {
    code: string,
    question: string,   // e.g. "Can you confirm your street address please?"
}

export interface Assessment {
    questionCode: string,
    result: "pass" | "fail" | "incomplete",
}

export interface RegistrationInterview {
    registrantCid: string,

    recordingCid: string,

    interviewerCid: string,

    assessment: Assessment[],

    /** Interviewer's signature of interview digest */
    signature: string,
}